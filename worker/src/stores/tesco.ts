import { NotReadyError, type StoreAdapter } from "./types.js";

// TODO(store automation): implement against the live tesco.ie site, then set ordering: true.
// See docs/STORE-AUTOMATION.md for what each method must do and how to test it.
export const tesco: StoreAdapter = {
  id: "tesco",
  name: "Tesco",
  ordering: false,
  signInUrl: "https://www.tesco.ie/account/login/en-IE",
  basketUrl: "https://www.tesco.ie/groceries/en-IE/trolley",
  async isSignedIn() {
    throw new NotReadyError("Tesco");
  },
  async getSlot() {
    throw new NotReadyError("Tesco");
  },
  async search() {
    throw new NotReadyError("Tesco");
  },
  async addToBasket() {
    throw new NotReadyError("Tesco");
  },
};
