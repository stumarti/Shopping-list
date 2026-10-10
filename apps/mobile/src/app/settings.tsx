import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, Label, s as ui } from "../components/ui";
import { useStore } from "../lib/store";
import { avatarColor, colors, initial, radius } from "../lib/theme";

const STATUS_TEXT = {
  unconfigured: { label: "Not set up", tone: "muted" },
  syncing: { label: "Syncing…", tone: "ok" },
  ok: { label: "Connected", tone: "ok" },
  offline: { label: "Can't reach", tone: "warn" },
  unauthorized: { label: "Wrong token", tone: "warn" },
  error: { label: "Server error", tone: "warn" },
} as const;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  // An invite link opens this screen with the server details filled in.
  const params = useLocalSearchParams<{ server?: string; token?: string }>();
  const settings = useStore((st) => st.settings);
  const status = useStore((st) => st.status);
  const lastSyncAt = useStore((st) => st.lastSyncAt);
  const waiting = useStore((st) => st.outbox.length);
  const items = useStore((st) => st.items);

  const [serverUrl, setServerUrl] = useState(params.server ?? settings.serverUrl);
  const [token, setToken] = useState(params.token ?? settings.token);
  const [name, setName] = useState(settings.name);
  const fromInvite = Boolean(params.server && params.token);

  useEffect(() => {
    if (fromInvite) Alert.alert("Join shared list", "The server details from your invite are filled in. Add your name and tap Save.");
  }, [fromInvite]);

  // Everyone who has added something, so you can see who's on the list.
  const people = useMemo(() => {
    const names = new Set(items.map((i) => i.addedBy).filter((n): n is string => Boolean(n)));
    if (settings.name) names.delete(settings.name);
    return [...names];
  }, [items, settings.name]);

  function save() {
    useStore.getState().setSettings({ serverUrl: serverUrl.trim(), token: token.trim(), name: name.trim() });
    void useStore.getState().sync();
  }

  async function invite() {
    if (!settings.serverUrl || !settings.token) {
      Alert.alert("Set up your server first", "Save a working server address and token, then invite your partner.");
      return;
    }
    const link = Linking.createURL("/settings", { queryParams: { server: settings.serverUrl, token: settings.token } });
    await Share.share({
      message: `Join our shopping list: install the Shopping app, then open this link on your phone:\n${link}`,
    });
  }

  const st = STATUS_TEXT[status];
  const pill = st.tone === "ok" ? { bg: colors.accentTint, fg: colors.accentInk } : st.tone === "warn" ? { bg: colors.warnBg, fg: colors.warnInk } : { bg: colors.chip, fg: colors.muted };
  const dirty = serverUrl.trim() !== settings.serverUrl || token.trim() !== settings.token || name.trim() !== settings.name;

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
          <View style={styles.person}>
            <View style={[styles.avatar, { backgroundColor: avatarColor(null, "") }]}>
              <Text style={styles.avatarText}>{initial(settings.name || "You")}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.personName}>{settings.name || "You"}</Text>
              <Text style={styles.small}>This device</Text>
            </View>
          </View>
          {people.map((p) => (
            <View key={p} style={[styles.person, styles.border]}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(p, settings.name) }]}>
                <Text style={styles.avatarText}>{initial(p)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.personName}>{p}</Text>
                <Text style={styles.small}>Can add, tick and reorder</Text>
              </View>
            </View>
          ))}
          <Pressable accessibilityRole="button" onPress={invite} style={[styles.person, styles.border]}>
            <Icon name="link-outline" color={colors.accent} size={20} />
            <Text style={styles.inviteText}>Invite with a link</Text>
          </Pressable>
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
                {settings.serverUrl || "Not set"}
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
          No connection? Changes are kept on this phone and sent as soon as the home server is reachable again.
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.h2}>Connection</Text>
        <Card style={{ padding: 16, gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Label>Your name</Label>
            <TextInput accessibilityLabel="Your name" value={name} onChangeText={setName} placeholder="Shown on items you add" placeholderTextColor={colors.faint} style={ui.input} />
          </View>
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
          <View style={{ gap: 6 }}>
            <Label>Access token</Label>
            <TextInput
              accessibilityLabel="Access token"
              value={token}
              onChangeText={setToken}
              placeholder="APP_TOKEN from the server's .env"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={ui.input}
            />
          </View>
          <Button label={dirty ? "Save and connect" : "Test connection"} onPress={save} />
        </Card>
      </View>
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
  inviteText: { fontSize: 16, fontWeight: "700", color: colors.accent },
  serverIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  pillText: { fontSize: 13, fontWeight: "700" },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, minHeight: 48 },
  kvKey: { fontSize: 15, color: colors.muted },
  kvVal: { fontSize: 15, fontWeight: "600", color: colors.ink },
});
