import * as Linking from "expo-linking";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, Label, s as ui } from "../components/ui";
import Constants from "expo-constants";
import { api, ApiError, type Health, type Person } from "../lib/api";
import { useStore } from "../lib/store";
import { avatarColor, colors, initial, radius } from "../lib/theme";

const STATUS_TEXT = {
  signedOut: { label: "Signed out", tone: "muted" },
  syncing: { label: "Syncing…", tone: "ok" },
  ok: { label: "Connected", tone: "ok" },
  offline: { label: "Can't reach", tone: "warn" },
  unauthorized: { label: "Signed out", tone: "warn" },
  error: { label: "Server error", tone: "warn" },
} as const;

function seen(t: number | null): string {
  if (!t) return "never";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const serverUrl = useStore((st) => st.serverUrl);
  const user = useStore((st) => st.user);
  const status = useStore((st) => st.status);
  const lastSyncAt = useStore((st) => st.lastSyncAt);
  const waiting = useStore((st) => st.outbox.length);

  const [people, setPeople] = useState<Person[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [name, setName] = useState(user?.name ?? "");

  const loadPeople = useCallback(() => {
    api
      .me(useStore.getState().connection())
      .then((r) => {
        setPeople(r.people);
        useStore.setState({ user: r.user });
      })
      .catch(() => setPeople(null));
    api
      .health(useStore.getState().connection())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  useFocusEffect(loadPeople);

  async function invite(forMe: boolean) {
    try {
      const { code } = await api.invite(useStore.getState().connection(), forMe);
      const link = Linking.createURL("/welcome", { queryParams: { server: serverUrl, code, kind: forMe ? "device" : "person" } });
      await Share.share({
        message: forMe
          ? `Open this on your other device (with the Shopping app installed) to sign in as ${user?.name ?? "me"}. Works once, for 7 days:\n${link}`
          : `Join our shopping list: install the Shopping app, then open this link on your phone. Works once, for 7 days:\n${link}`,
      });
    } catch (err) {
      Alert.alert("Couldn't create an invite", err instanceof ApiError ? err.message : "Try again when you're connected to the home server.");
    }
  }

  function revoke(p: Person) {
    Alert.alert(`Sign out ${p.name}?`, `All of ${p.name}'s devices will be signed out and need a new invite to get back in. Use this for a lost or sold phone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await api.revoke(useStore.getState().connection(), p.id).catch(() => {});
          loadPeople();
        },
      },
    ]);
  }

  async function saveName() {
    if (!name.trim() || name.trim() === user?.name) return;
    try {
      await api.rename(useStore.getState().connection(), name.trim());
      loadPeople();
      void useStore.getState().sync();
    } catch {
      Alert.alert("Couldn't save your name", "Try again when you're connected to the home server.");
    }
  }

  // Everything useful for a bug report in one block, without the token.
  async function shareDiagnostics() {
    const s = useStore.getState();
    const lines = [
      `App ${Constants.expoConfig?.version ?? "?"} · ${Constants.deviceName ?? "device"}`,
      `Server ${serverUrl || "not set"} · version ${health?.version ?? "unreachable"}`,
      `Status ${s.status} · last sync ${s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : "never"} · ${s.outbox.length} waiting`,
      `AI ${health?.ai?.name ?? "off"} · price checks ${health?.priceCheck ? "on" : "off"}`,
      `Signed in as ${user?.name ?? "?"} · ${s.lists.length} lists · ${s.items.length} items`,
    ];
    await Share.share({ message: lines.join("\n") });
  }

  function signOut() {
    Alert.alert("Sign out of this device?", "Your lists stay on the server. You'll need an invite or the setup token to sign back in.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await useStore.getState().signOut();
          router.replace("/welcome");
        },
      },
    ]);
  }

  const st = STATUS_TEXT[status];
  const pill = st.tone === "ok" ? { bg: colors.accentTint, fg: colors.accentInk } : st.tone === "warn" ? { bg: colors.warnBg, fg: colors.warnInk } : { bg: colors.chip, fg: colors.muted };

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 28, gap: 22 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>List</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Sharing & sync
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.h2}>People</Text>
        <Card>
          {(people ?? (user ? [{ ...user, devices: 1, lastSeen: null, isMe: true }] : [])).map((p, i) => (
            <View key={p.id} style={[styles.person, i > 0 && styles.border]}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(p.isMe) }]}>
                <Text style={styles.avatarText}>{initial(p.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.personName}>{p.isMe ? `${p.name} (you)` : p.name}</Text>
                <Text style={styles.small}>
                  {p.devices === 0 ? "Signed out" : `${p.devices} device${p.devices === 1 ? "" : "s"} · active ${seen(p.lastSeen)}`}
                </Text>
              </View>
              {!p.isMe && p.devices > 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Sign out ${p.name}`} onPress={() => revoke(p)} hitSlop={6} style={styles.smallBtn}>
                  <Text style={styles.smallBtnText}>Sign out</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          <Pressable accessibilityRole="button" onPress={() => invite(false)} style={[styles.person, styles.border]}>
            <Icon name="person-add-outline" color={colors.accent} size={20} />
            <Text style={styles.inviteText}>Invite someone</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => invite(true)} style={[styles.person, styles.border]}>
            <Icon name="tablet-portrait-outline" color={colors.accent} size={20} />
            <Text style={styles.inviteText}>Add another device for me</Text>
          </Pressable>
        </Card>
        <Text style={[styles.small, { paddingHorizontal: 4 }]}>Invite links work once and expire after 7 days. Everyone shares the main list; private lists are only visible to the person who made them.</Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.h2}>Your name</Text>
        <Card style={{ padding: 16, gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Label>Shown on items you add</Label>
            <TextInput accessibilityLabel="Your name" value={name} onChangeText={setName} onSubmitEditing={saveName} returnKeyType="done" style={ui.input} />
          </View>
          {name.trim() && name.trim() !== user?.name ? <Button label="Save name" onPress={saveName} /> : null}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.h2}>Sync</Text>
        <Card>
          <View style={styles.person}>
            <View style={styles.serverIcon}>
              <Icon name="server-outline" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.personName}>Home server</Text>
              <Text style={styles.small} numberOfLines={1}>
                {serverUrl || "Not set"}
              </Text>
            </View>
            <View style={[styles.pill, { backgroundColor: pill.bg }]}>
              <Text style={[styles.pillText, { color: pill.fg }]}>{st.label}</Text>
            </View>
          </View>
          <View style={[styles.kv, styles.border]}>
            <Text style={styles.kvKey}>Last synced</Text>
            <Text style={styles.kvVal}>{lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Never"}</Text>
          </View>
          <View style={[styles.kv, styles.border]}>
            <Text style={styles.kvKey}>Changes waiting to send</Text>
            <Text style={styles.kvVal}>{waiting}</Text>
          </View>
        </Card>
        <Text style={[styles.small, { paddingHorizontal: 4 }]}>
          No connection? Changes are kept on this device and sent as soon as the home server is reachable again.
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.h2}>Server features</Text>
        <Card>
          <View style={styles.kv}>
            <Text style={styles.kvKey}>Photo identification</Text>
            <Text style={styles.kvVal}>{health ? (health.ai?.name ?? "Off") : "–"}</Text>
          </View>
          <View style={[styles.kv, styles.border]}>
            <Text style={styles.kvKey}>Price checks</Text>
            <Text style={styles.kvVal}>{health ? (health.priceCheck ? "On" : "Off") : "–"}</Text>
          </View>
          <View style={[styles.kv, styles.border]}>
            <Text style={styles.kvKey}>Server version</Text>
            <Text style={styles.kvVal}>{health?.version ?? "–"}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={shareDiagnostics} style={[styles.person, styles.border]}>
            <Icon name="bug-outline" color={colors.accent} size={20} />
            <Text style={styles.inviteText}>Share diagnostics</Text>
          </Pressable>
        </Card>
      </View>

      <Button label="Sign out of this device" variant="danger" icon="log-out-outline" onPress={signOut} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  h2: { marginHorizontal: 4, fontSize: 13, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: colors.muted },
  person: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarText: { fontWeight: "700", color: colors.ink },
  personName: { fontSize: 16, fontWeight: "600", color: colors.ink },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  smallBtn: { minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.chip, justifyContent: "center" },
  smallBtnText: { fontSize: 13, fontWeight: "700", color: colors.ink },
  inviteText: { fontSize: 16, fontWeight: "700", color: colors.accent },
  serverIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  pillText: { fontSize: 13, fontWeight: "700" },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, minHeight: 48 },
  kvKey: { fontSize: 15, color: colors.muted },
  kvVal: { fontSize: 15, fontWeight: "600", color: colors.ink },
});
