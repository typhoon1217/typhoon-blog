---
title: JPA orphanRemoval — 컬렉션에서 제거하면 DB에서도 지워진다
published: 2026-04-14
description: orphanRemoval=true가 정확히 무엇을 하는지, CascadeType.REMOVE와 어떻게 다른지.
tags:
  - backend
  - spring-boot
  - jpa
  - korean
category: Backend
draft: false
---

`@OneToMany`에 `orphanRemoval = true`를 붙이면, 부모 컬렉션에서 자식 엔티티를 제거할 때 JPA가 자동으로 DELETE 쿼리를 날린다.

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

`order.getItems().remove(item)` 한 줄이면 트랜잭션 커밋 시 해당 `OrderItem`이 DB에서 삭제된다.

## CascadeType.REMOVE와 차이

헷갈리는 지점이다.

**CascadeType.REMOVE**: 부모 엔티티가 삭제될 때 자식도 같이 삭제된다.

```java
// order를 삭제하면 → items도 삭제
em.remove(order);
```

**orphanRemoval**: 부모의 컬렉션에서 자식이 빠질 때 삭제된다. 부모가 살아있어도.

```java
// order는 살아있고, items 컬렉션에서만 제거 → DB에서 삭제
order.getItems().remove(item);
```

둘을 같이 쓰면 두 경우 모두 처리된다. 대부분 같이 쓴다.

## 동작 원리

JPA dirty checking이 핵심이다. 트랜잭션 안에서 영속성 컨텍스트가 컬렉션 변화를 추적한다. 커밋 전 flush 시점에 컬렉션에서 빠진 엔티티를 감지하고 DELETE를 실행한다.

직접 `em.remove(item)`을 호출하지 않아도 된다. 컬렉션 조작만으로 충분하다.

## 주의할 점

### 자식 엔티티가 다른 곳에서도 참조되면 안 된다

orphanRemoval은 "이 자식은 이 부모만 소유한다"는 전제다. 같은 자식 엔티티를 다른 부모나 다른 연관관계가 참조하고 있으면 예상치 못한 삭제가 발생한다.

### 컬렉션 교체 시 주의

```java
// 위험: 기존 컬렉션의 모든 항목이 orphan으로 처리돼 전부 삭제된다
order.setItems(newItems);

// 안전: 기존 컬렉션을 유지하며 수정
order.getItems().clear();
order.getItems().addAll(newItems);
```

setter로 컬렉션 통째로 교체하면 기존 항목이 전부 orphan으로 처리돼 삭제된다. 의도한 게 아니라면 컬렉션 내부를 수정하는 방식을 써야 한다.

### 양방향 연관관계에서 양쪽 모두 끊어야 한다

```java
// 한쪽만 끊으면 dirty checking이 제대로 작동 안 할 수 있다
item.setOrder(null);            // 자식의 외래키 참조 제거
order.getItems().remove(item);  // 부모 컬렉션에서 제거
```

실수하기 쉬운 부분이라 보통 연관관계 편의 메서드로 묶어둔다.

## 실용적인 패턴

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    public void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);
    }

    public void removeItem(OrderItem item) {
        items.remove(item);
        item.setOrder(null);
    }
}
```

`addItem`과 `removeItem`으로 양방향 연관관계를 한 곳에서 관리한다. 외부에서 직접 컬렉션을 건드리지 않게 한다.

---

`orphanRemoval = true`는 자식 엔티티의 생명주기를 부모에게 완전히 위임할 때 쓴다. 컬렉션에서 빼면 지워져야 하는 관계라면 붙여두면 된다.
