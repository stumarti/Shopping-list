/* Material Symbols (rounded, from @material-symbols/svg-400), bundled so the page works without the internet. */
import cart from "@material-symbols/svg-400/rounded/shopping_cart.svg?raw";
import cartFill from "@material-symbols/svg-400/rounded/shopping_cart-fill.svg?raw";
import store from "@material-symbols/svg-400/rounded/storefront.svg?raw";
import list from "@material-symbols/svg-400/rounded/format_list_bulleted.svg?raw";
import settings from "@material-symbols/svg-400/rounded/settings.svg?raw";
import light from "@material-symbols/svg-400/rounded/light_mode.svg?raw";
import dark from "@material-symbols/svg-400/rounded/dark_mode.svg?raw";
import auto from "@material-symbols/svg-400/rounded/contrast.svg?raw";
import close from "@material-symbols/svg-400/rounded/close.svg?raw";
import add from "@material-symbols/svg-400/rounded/add.svg?raw";
import checked from "@material-symbols/svg-400/rounded/check_circle-fill.svg?raw";
import unchecked from "@material-symbols/svg-400/rounded/radio_button_unchecked.svg?raw";
import copy from "@material-symbols/svg-400/rounded/content_copy.svg?raw";
import open from "@material-symbols/svg-400/rounded/open_in_new.svg?raw";
import link from "@material-symbols/svg-400/rounded/link.svg?raw";
import lock from "@material-symbols/svg-400/rounded/lock.svg?raw";
import savings from "@material-symbols/svg-400/rounded/savings.svg?raw";
import fire from "@material-symbols/svg-400/rounded/local_fire_department.svg?raw";
import chart from "@material-symbols/svg-400/rounded/bar_chart.svg?raw";
import event from "@material-symbols/svg-400/rounded/event.svg?raw";
import trash from "@material-symbols/svg-400/rounded/delete.svg?raw";
import undo from "@material-symbols/svg-400/rounded/undo.svg?raw";
import search from "@material-symbols/svg-400/rounded/search.svg?raw";
import basket from "@material-symbols/svg-400/rounded/shopping_basket.svg?raw";

const SOURCES = { cart, cartFill, store, list, settings, light, dark, auto, close, add, checked, unchecked, copy, open, link, lock, savings, fire, chart, event, trash, undo, search, basket };
export type IconName = keyof typeof SOURCES;

// Just the drawing: the path data from each file.
const PATHS = Object.fromEntries(
  Object.entries(SOURCES).map(([name, svg]) => [name, [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])]),
) as Record<IconName, string[]>;

/** A Material Symbol in the text colour. Decorative unless given a label. */
export default function Icon({ name, size = 20, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
