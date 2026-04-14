---
title: JPA orphanRemoval — Remove from collection, delete from DB
published: 2026-04-14
description: What orphanRemoval=true actually does, and how it differs from CascadeType.REMOVE.
tags:
  - backend
  - spring-boot
  - jpa
  - english
category: Backend
draft: false
---

Add `orphanRemoval = true` to a `@OneToMany`, and JPA will automatically issue a DELETE when you remove a child entity from the parent's collection.

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

One line — `order.getItems().remove(item)` — and the `OrderItem` is gone from the database on transaction commit. No explicit `em.remove()` needed.

## orphanRemoval vs CascadeType.REMOVE

They sound similar but trigger on different events.

**CascadeType.REMOVE** fires when the parent entity is deleted:

```java
em.remove(order); // → also deletes all its items
```

**orphanRemoval** fires when a child is removed from the parent's collection — even if the parent still exists:

```java
order.getItems().remove(item); // → item deleted from DB, order stays
```

In practice, most relationships that need one need both. Using `cascade = CascadeType.ALL` covers the parent-deletion case while `orphanRemoval = true` handles collection removal.

## How it works

JPA's dirty checking tracks changes to your collections within a persistence context. At flush time (before commit), it compares the current state of the collection to the snapshot taken when the entity was loaded. Any entity that disappeared from the collection is treated as an orphan and scheduled for deletion.

## Gotchas

### Don't share orphanRemoval children

orphanRemoval implies exclusive ownership. If another entity or relationship also references the same child, you'll get unexpected deletes. It's only safe when one parent fully owns the child's lifecycle.

### Replacing the whole collection deletes everything

```java
// Dangerous: all existing items become orphans → all deleted
order.setItems(newItems);

// Safe: mutate the existing collection
order.getItems().clear();
order.getItems().addAll(newItems);
```

Swapping the collection reference via setter marks every previous item as orphaned. If that's not what you want, always mutate in place.

### Bidirectional relationships need both sides disconnected

```java
item.setOrder(null);            // remove child's FK reference
order.getItems().remove(item);  // remove from parent's collection
```

Skipping either side can cause dirty checking to miss the change. The clean way is to encapsulate this in helper methods:

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

Keep `items` private, expose only `addItem` and `removeItem`. External code never touches the collection directly.

---

Use `orphanRemoval = true` when the child's lifecycle is fully owned by the parent — if removing it from the collection means it should no longer exist, this is exactly the right tool.
