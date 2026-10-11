import { NotReadyError, type StoreAdapter } from "./types.js";

// TODO(store automation): implement against the live Dunnes Stores grocery site, then set ordering: true.
// See docs/STORE-AUTOMATION.md for what each method must do and how to test it.
export const dunnes: StoreAdapter = {
  id: "dunnes",
  name: "Dunnes Stores",
  ordering: false,
  signInUrl: "https://www.dunnesstoresgrocery.com/",
  basketUrl: "https://www.dunnesstoresgrocery.com/",
  async isSignedIn() {
    throw new NotReadyError("Dunnes Stores");
  },
  async getSlot() {
    throw new NotReadyError("Dunnes Stores");
  },
  async search() {
    throw new NotReadyError("Dunnes Stores");
  },
  async addToBasket() {
    throw new NotReadyError("Dunnes Stores");
  },
};
