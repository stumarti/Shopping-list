import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Label, s as ui } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

/**
 * First run. Either set up the server (needs APP_TOKEN from the server's .env) or join with an
 * invite link from someone already using it. Invite links open this screen with the details filled in.
 */
export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ server?: string; code?: string; kind?: string }>();
  const joining = Boolean(params.code);
  const sameDevicePerson = params.kind === "device";

  const [serverUrl, setServerUrl] = useState(params.server ?? useStore.getState().serverUrl);
  const [setupToken, setSetupToken] = useState("");
  const [name, setName] = useState(useStore.getState().legacyName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsName = !joining || !sameDevicePerson;
  // The setup token is only needed when the server sets APP_TOKEN; the server says so if it's missing.
  const ready = serverUrl.trim() && (!needsName || name.trim());

  async function go() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const conn = { serverUrl: serverUrl.trim(), token: null };
    try {
      const res = joining ? await api.join(conn, params.code!, needsName ? name.trim() : undefined) : await api.setup(conn, setupToken.trim(), name.trim());
      await useStore.getState().signIn(conn.serverUrl, res.token, res.user);
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.ground }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 40, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 20 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={styles.title}>
            {joining ? (sameDevicePerson ? "Add this device" : "Join the list") : "Set up Shopping"}
          </Text>
          <Text style={styles.sub}>
            {joining
              ? sameDevicePerson
                ? "This device will sign in as you and share your lists."
                : "You've been invited to a shared shopping list."
              : "Connect to the server running at home."}
          </Text>
        </View>

        <Card style={{ padding: 16, gap: 14 }}>
          {needsName ? (
            <View style={{ gap: 6 }}>
              <Label>Your name</Label>
              <TextInput accessibilityLabel="Your name" value={name} onChangeText={setName} placeholder="Shown on items you add" placeholderTextColor={colors.faint} style={ui.input} />
            </View>
          ) : null}
          <View style={{ gap: 6 }}>
            <Label>Server address</Label>
            <TextInput
              accessibilityLabel="Server address"
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://homeserver.your-tailnet.ts.net"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={ui.input}
            />
          </View>
          {joining ? null : (
            <View style={{ gap: 6 }}>
              <Label>Setup token (only if your server has one)</Label>
              <TextInput
                accessibilityLabel="Setup token"
                value={setupToken}
                onChangeText={setSetupToken}
                placeholder="APP_TOKEN from the server's .env, or leave empty"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={ui.input}
              />
            </View>
          )}
          {error ? (
            <View style={styles.error}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          <Button label={busy ? "Connecting…" : joining ? "Join" : "Connect"} onPress={go} disabled={!ready || busy} />
        </Card>

        {joining ? (
          <Pressable accessibilityRole="button" onPress={() => router.setParams({ code: undefined, kind: undefined })} style={styles.link}>
            <Text style={styles.linkText}>Set up with a token instead</Text>
          </Pressable>
        ) : (
          <Text style={styles.hint}>Joining someone else's list? Ask them to send you an invite link from Sharing & sync, then open it on this phone.</Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.6, color: colors.ink },
  sub: { fontSize: 16, lineHeight: 23, color: colors.muted },
  error: { backgroundColor: "#FBE9E7", borderRadius: radius.sm, padding: 12 },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  link: { alignSelf: "center", minHeight: 44, justifyContent: "center" },
  linkText: { fontSize: 15, fontWeight: "600", color: colors.accent },
  hint: { fontSize: 14, lineHeight: 20, color: colors.muted, textAlign: "center", paddingHorizontal: 12 },
});
