import { useState } from "react";

export type Order = "often" | "aisle";
const KEY = "shopping-list.order";

/** How lists are ordered: most bought first, or aisle by aisle. Remembered on this device. */
export function useOrder(): [Order, (order: Order) => void] {
  const [order, setOrder] = useState<Order>(() => {
    try {
      return localStorage.getItem(KEY) === "aisle" ? "aisle" : "often";
    } catch {
      return "often";
    }
  });
  const set = (o: Order) => {
    setOrder(o);
    try {
      localStorage.setItem(KEY, o);
    } catch {
      // Not remembered on this device; the order still changes.
    }
  };
  return [order, set];
}

export function OrderToggle({ order, setOrder }: { order: Order; setOrder: (order: Order) => void }) {
  return (
    <div className="order" role="group" aria-label="Order">
      <button aria-pressed={order === "often"} onClick={() => setOrder("often")}>
        Most bought
      </button>
      <button aria-pressed={order === "aisle"} onClick={() => setOrder("aisle")}>
        By aisle
      </button>
    </div>
  );
}

/** Most bought first; ties by name. */
export const byTrips = <T extends { trips: number; name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => b.trips - a.trips || a.name.localeCompare(b.name));
