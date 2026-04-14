---
author: 신중우 (Shin Jungwoo)
pubDatetime: 2026-04-14T01:00:00Z
title: JPA orphanRemoval이 번역 데이터를 조용히 삭제한 이유
slug: jpa-orphan-removal-copy-pattern-trap
featured: false
draft: false
tags:
  - backend
  - spring-boot
  - jpa
  - korean
description: 카테고리 상태 변경 한 번에 번역 데이터 전체가 사라졌다. orphanRemoval과 불변 엔티티 패턴이 충돌하는 지점을 짚어본다.
---

카테고리 활성/비활성을 토글하고 저장하면 번역 데이터가 전부 사라졌다. 드래그앤드롭으로 순서를 바꿔도 마찬가지였다. DB를 확인해보니 `category_translations` 행이 없다.

## 코드가 뭘 하고 있었나

엔티티는 불변(immutable) 패턴으로 설계되어 있었다. setter를 노출하지 않고, 변경이 필요하면 `with*` 메서드가 복사본을 만들어 반환하는 방식이다.

```java
// Category.java
private Category copyWith() {
    return Category.builder()
            .id(this.id)
            .isActive(this.isActive)
            .sortOrder(this.sortOrder)
            // ... 다른 필드들
            // translations는 여기 없음
            .build();
}

public Category withActiveStatus(Boolean isActive) {
    Category copy = copyWith();
    copy.isActive = isActive;
    return copy;
}
```

서비스 코드는 이렇게 생겼다.

```java
public Category updateActiveStatus(Long id, boolean isActive) {
    Category category = findById(id);
    Category updated = category.withActiveStatus(isActive);
    return categoryRepository.save(updated);
}
```

`findById` → 복사 → `save`. 얼핏 보면 문제없어 보인다.

## 어디서 터지나

`Category`의 번역 관계 선언을 보면:

```java
@OneToMany(mappedBy = "category", cascade = CascadeType.ALL, orphanRemoval = true)
private List<CategoryTranslation> translations = new ArrayList<>();
```

`orphanRemoval = true`는 **이 컬렉션에서 빠진 행을 DB에서 삭제하라**는 의미다.

`copyWith()`는 `translations`를 포함하지 않는다. 빌더가 새 인스턴스를 만들면 `translations`는 `new ArrayList<>()`— 빈 리스트다.

`categoryRepository.save(updated)`는 내부에서 JPA의 `merge()`를 호출한다. Hibernate는 이렇게 판단한다:

> ID가 같은 기존 엔티티가 있다. 새로 들어온 엔티티의 translations는 비어 있다. orphanRemoval이 켜져 있으니 기존 번역을 전부 삭제한다.

실제로 실행된 SQL:

```sql
DELETE FROM category_translations WHERE category_id = ?
UPDATE categories SET is_active = ? WHERE id = ?
```

상태 변경 하나에 번역 전체가 날아간다.

## 왜 이제 발견됐나

`updateSortOrder`도 동일한 패턴이었다. 순서 변경은 트리 페이지에서 드래그앤드롭으로 발생하는데, 그 직후 트리를 다시 불러오기 때문에 번역이 사라진 걸 바로 인식하기 어려웠다. 상세 페이지에서 직접 저장하면서 확인한 순간에 드러났다.

## 수정

JPA에서 엔티티를 수정하는 올바른 방법은 단순하다. `findById()`로 가져온 **관리(managed) 엔티티를 그 자리에서 바꾸면 된다.** 트랜잭션이 끝날 때 Hibernate의 dirty-checking이 변경된 컬럼만 감지해서 `UPDATE`를 실행한다.

```java
// Category.java — copy 메서드 제거, 직접 변경 메서드 추가
public void changeActiveStatus(boolean isActive) {
    this.isActive = isActive;
}

public void changeSortOrder(Integer sortOrder) {
    this.sortOrder = sortOrder != null ? sortOrder : 0;
}
```

```java
// CategoryService.java
public Category updateActiveStatus(Long id, boolean isActive) {
    Category category = findById(id);
    category.changeActiveStatus(isActive);
    return category;
    // save() 호출 없음
    // @Transactional 종료 시 dirty-checking이 알아서 UPDATE
}
```

실행되는 SQL:

```sql
UPDATE categories SET is_active = ? WHERE id = ?
```

`translations`는 건드리지 않았으니 orphanRemoval도 발동하지 않는다.

## 교훈

`orphanRemoval = true`와 copy 패턴은 같이 쓰면 안 된다.

`findById()`로 가져온 엔티티는 영속성 컨텍스트가 관리한다. 이걸 복사해서 새 Java 객체를 만드는 순간 **분리(detached) 상태**가 된다. `save()`가 `merge()`를 호출하면 분리 객체의 상태 전체가 관리 엔티티에 덮어씌워진다. 빈 컬렉션도 포함해서.

불변 엔티티 패턴 자체가 나쁜 건 아니지만, JPA 영속성 컨텍스트와 조합할 때는 이 지점을 정확히 이해하고 있어야 한다. 관리 엔티티를 복사하면 JPA의 보호 범위를 벗어난다.
