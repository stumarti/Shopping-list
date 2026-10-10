import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// The personal token lives in the iPhone Keychain, not in the app's regular storage.
// (The web build, used only for development, falls back to localStorage.)
const KEY = "shopping-list.token";
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export async function loadToken(): Promise<string | null> {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(KEY) ?? null;
  return SecureStore.getItemAsync(KEY, options);
}

export async function saveToken(token: string | null): Promise<void> {
  if (Platform.OS === "web") {
    if (token) globalThis.localStorage?.setItem(KEY, token);
    else globalThis.localStorage?.removeItem(KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(KEY, token, options);
  else await SecureStore.deleteItemAsync(KEY, options);
}
