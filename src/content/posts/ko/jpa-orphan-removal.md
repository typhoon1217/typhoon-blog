---
title: JPA orphanRemoval — 컬렉션에서 제거하면 DB에서도 지워진다
published: 2026-04-14
description: orphanRemoval=true가 정확히 무엇을 하는지, CascadeType.REMOVE와 어떻게 다른지, 그리고 같이 쓸 때 자주 빠지는 함정 세 가지.
tags:
  - backend
  - spring-boot
  - jpa
  - korean
category: Backend
draft: false
---

`@OneToMany`에 `orphanRemoval = true`를 붙이면, 부모 컬렉션에서 자식 엔티티를 제거할 때 JPA가 자동으로 DELETE를 날린다.

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

`order.getItems().remove(item)` 한 줄이면 트랜잭션 커밋 시 해당 `OrderItem`이 DB에서 삭제된다. `em.remove()`를 따로 부를 필요가 없다.

## CascadeType.REMOVE와는 다른 시점에 동작한다

이름이 비슷해서 헷갈리지만, 두 옵션은 *다른 사건*에 반응한다.

**CascadeType.REMOVE**는 부모 엔티티가 삭제될 때 발동한다.

```java
em.remove(order); // → items도 같이 삭제
```

**orphanRemoval**은 부모의 컬렉션에서 자식이 빠질 때 발동한다. 부모가 살아있어도.

```java
order.getItems().remove(item); // → item이 DB에서 삭제, order는 그대로
```

실무에서는 둘이 같이 필요한 경우가 대부분이라 보통 함께 쓴다. `cascade = CascadeType.ALL`로 부모 삭제 케이스를 처리하고, `orphanRemoval = true`로 컬렉션 제거 케이스를 처리하는 식이다.

## 동작 원리 — JPA dirty checking

영속성 컨텍스트가 트랜잭션 안에서 컬렉션의 변화를 추적한다. flush 시점에 컬렉션을 로드 시점의 스냅샷과 비교해, 사라진 엔티티를 orphan으로 분류하고 DELETE 큐에 올린다.

따라서 직접 `em.remove(item)`을 호출하지 않아도 된다. 컬렉션 조작만으로 충분하다.

## 함정 1: 같은 자식을 다른 곳에서 참조하면 안 된다

orphanRemoval은 "이 자식은 이 부모만 소유한다"는 전제 위에서 동작한다. 같은 자식 엔티티를 다른 부모나 다른 연관관계가 참조하고 있으면 예상치 못한 삭제가 일어난다. 엄격한 부모-자식 관계에서만 안전한 옵션이다.

## 함정 2: 컬렉션 통째로 교체하면 전부 삭제된다

```java
// 위험: 기존 컬렉션의 모든 항목이 orphan으로 분류돼 전부 삭제
order.setItems(newItems);

// 안전: 기존 컬렉션을 유지하며 내부만 수정
order.getItems().clear();
order.getItems().addAll(newItems);
```

setter로 컬렉션 reference 자체를 바꾸면 기존 항목이 전부 orphan으로 분류된다. 의도한 게 아니라면 컬렉션 내부를 수정하는 방식을 써야 한다.

## 함정 3: 양방향 연관관계는 양쪽 모두 끊어야 한다

```java
// 한쪽만 끊으면 dirty checking이 제대로 동작 안 할 수 있다
item.setOrder(null);            // 자식의 외래키 참조 제거
order.getItems().remove(item);  // 부모 컬렉션에서 제거
```

실수하기 쉬운 부분이라 보통 연관관계 편의 메서드로 묶어둔다.

## 실용 패턴 — 컬렉션을 직접 노출하지 않는다

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

`addItem`과 `removeItem`으로 양방향 관계를 한 곳에서 관리한다. 외부에서 직접 컬렉션을 건드리지 못하게 막아두면 위 함정 세 가지가 자동으로 차단된다.

---

`orphanRemoval = true`는 자식 엔티티의 생명주기를 부모에게 *완전히* 위임할 때 쓴다. "컬렉션에서 빼면 DB에서도 지워진다"가 자연스러운 관계라면 붙이면 된다. 아니라면 명시적인 삭제 쪽이 안전하다.
