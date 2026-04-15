---
title: "Hibernate 프록시가 트랜잭션 밖에서 터지는 이유"
published: 2026-04-15
description: LazyInitializationException이 왜 발생하는지, @EntityGraph로 어떻게 고치는지 정리.
tags:
  - backend
  - spring-boot
  - jpa
  - korean
category: Backend
draft: false
---

PUT 요청을 보냈는데 500이 떴다. 로그를 확인하니:

```
LazyInitializationException: could not initialize proxy
  [com.metsakuur.core.domain.document.entity.Template#8] - no Session
```

Hibernate 프록시 초기화 문제다.

## 뭐가 문제였나

서비스 코드는 이렇게 생겼다.

```java
@Transactional(readOnly = true)
public Map<String, Map<TemplateType, Template>> getDefaultTemplatesForCategory(Long categoryId) {
    List<CategoryDefaultTemplate> rows = categoryDefaultTemplateRepository.findByCategoryId(categoryId);
    Map<String, Map<TemplateType, Template>> result = new LinkedHashMap<>();
    for (CategoryDefaultTemplate row : rows) {
        result.computeIfAbsent(row.getLangCode(), k -> new LinkedHashMap<>())
                .put(row.getType(), row.getTemplate()); // 여기
    }
    return result;
}
```

`row.getTemplate()`을 루프 안에서 호출하고 있으니 트랜잭션 안에서 프록시가 초기화되겠지, 라고 생각하기 쉽다. 하지만 그렇지 않다.

`row.getTemplate()`은 프록시 **객체를 반환**할 뿐이다. 프록시를 초기화하지 않는다.

Hibernate는 `@ManyToOne(fetch = FetchType.LAZY)` 연관관계를 로딩할 때 실제 `Template` 인스턴스 대신 프록시 객체를 만들어둔다. `getTemplate()`을 호출하면 이 프록시 레퍼런스를 그냥 돌려준다. DB 조회는 일어나지 않는다.

실제 DB 조회는 `template.getSlug()`처럼 **ID가 아닌 필드에 처음 접근할 때** 발생한다.

컨트롤러 코드로 돌아오면:

```java
categoryService.setDefaultTemplate(...);
Map<String, Map<TemplateType, Template>> byLang = categoryService.getDefaultTemplatesForCategory(id);
Map<TemplateType, Template> langMap = byLang.getOrDefault(lang, Map.of());
return ResponseEntity.ok(DefaultTemplatesResponse.of(
        lang,
        langMap.get(TemplateType.VIEW),
        langMap.get(TemplateType.DOWNLOAD)));
```

`getDefaultTemplatesForCategory` 트랜잭션이 종료된 뒤에 컨트롤러가 `DefaultTemplatesResponse.of(...)`를 호출한다. 그 안에서:

```java
viewTemplate != null ? viewTemplate.getId() : null,    // 안전 — 프록시에 ID 내장됨
viewTemplate != null ? viewTemplate.getSlug() : null,  // 여기서 터짐
```

`getSlug()`가 프록시 초기화를 시도하는 시점에 세션이 이미 닫혀 있다. 예외 발생.

`getId()`가 안전한 이유는 따로 있다. Hibernate가 프록시를 생성할 때 ID 값을 프록시 객체 자체에 박아두기 때문에 세션 없이도 접근 가능하다.

## 왜 getId()는 되고 getSlug()는 안 되나

Hibernate 프록시는 진짜 엔티티 클래스의 서브클래스다. PK 필드는 프록시 생성 시점에 이미 채워진다. 그 외 필드는 처음 접근하는 시점에 DB 조회를 하도록 설계되어 있다. 세션이 없으면 그 조회가 불가능하다.

## 고친 방법

레포지터리 메서드에 `@EntityGraph`를 추가했다.

```java
@EntityGraph(attributePaths = "template")
List<CategoryDefaultTemplate> findByCategoryId(Long categoryId);
```

`@EntityGraph`는 이 쿼리에서만 `template`을 LEFT JOIN FETCH로 가져오도록 한다. 엔티티의 기본 fetch 전략(`LAZY`)은 그대로 유지된다.

다른 선택지들도 있다:

- `@ManyToOne(fetch = FetchType.EAGER)` — 엔티티 수준에서 항상 즉시 로딩. 이 연관관계를 쓰는 모든 쿼리에 영향이 가므로 과하다.
- JPQL에 `JOIN FETCH` 직접 작성 — 가능하지만 derived query 대신 `@Query`로 바꿔야 한다.
- `Hibernate.initialize(row.getTemplate())` — 트랜잭션 안에서 강제 초기화. 동작하지만 N+1 문제를 그대로 안고 간다.

연관관계 하나를 페치하는 경우라면 `@EntityGraph`가 가장 깔끔하다.

## 정리

`row.getAssociation()`은 프록시를 초기화하지 않는다. 초기화는 ID 외의 필드에 처음 접근할 때 일어난다. 트랜잭션이 닫힌 뒤에 그 접근이 일어나면 예외가 난다.

서비스에서 엔티티 그래프를 반환하고 컨트롤러에서 소비하는 패턴을 쓴다면, 트랜잭션 안에서 필요한 연관관계가 모두 초기화되는지 항상 확인해야 한다.
