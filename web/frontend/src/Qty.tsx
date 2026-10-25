import { api, type NextShop, type ShopItem } from "./api";
import Icon from "./Icon";

/** − 2 + : how many to get. Big enough to tap, labelled for screen readers. */
export default function Qty({ value, name, onChange }: { value: number; name: string; onChange: (qty: number) => void }) {
  return (
    <span className="qty" role="group" aria-label={`How many ${name}`}>
      <button type="button" aria-label={`One fewer ${name}`} disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 12h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      </button>
      <span className="qty-value" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`One more ${name}`} disabled={value >= 99} onClick={() => onChange(value + 1)}>
        <Icon name="add" size={16} />
      </button>
    </span>
  );
}

/** Change how many of something on the next shop: on the list for what you added, else just for this shop. */
export async function changeQty(item: ShopItem, qty: number): Promise<NextShop | null> {
  if (item.list_item_id !== null) {
    await api.change(item.list_item_id, { qty });
    return null; // the caller reloads the plan
  }
  return api.setShopQty(item.catalog_id!, qty);
}
