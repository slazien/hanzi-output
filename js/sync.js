// Optional accounts: sign in with Google or an emailed code, and keep the
// practice data in sync across devices through Supabase. Without a
// configured project (js/config.js) or without signing in, the app works
// from this device's storage alone, exactly as before.

import { createClient } from "../vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { state, save, onSave, replaceState } from "./store.js";
import { mergeStates } from "./merge.js";

export const accountsEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const status = { email: "", syncing: false, lastSync: 0, error: "" };

const PUSH_DELAY = 20000; // wait this long after the last change before uploading
const listeners = new Set();
let client = null;
let session = null;
let dirty = false;
let timer = null;

export const onSyncChange = (fn) => listeners.add(fn);
const notify = (dataChanged = false) => listeners.forEach((fn) => fn(dataChanged));

export function initSync() {
  if (!accountsEnabled) return;
  // "implicit" lets a sign-in link from an email work in whichever browser
  // opens it; the stricter "pkce" flow only works in the browser that asked.
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true } });
  client.auth.onAuthStateChange((event, s) => {
    session = s;
    status.email = s?.user?.email || "";
    if (!s) status.lastSync = 0;
    notify();
    // Supabase calls must not run inside this callback, so sync on the next tick.
    if (s && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) setTimeout(() => syncNow(), 0);
  });
  onSave(() => {
    if (!session) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(), PUSH_DELAY);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) syncNow();
  });
}

const friendly = (error) => error?.message || "Something went wrong.";

export async function signInWithGoogle() {
  const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
  if (error) throw new Error(friendly(error));
}

// Emails a sign-in link (and a 6-digit code, if the project's email template includes one).
export async function sendEmailCode(email) {
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(friendly(error));
}

export async function verifyEmailCode(email, token) {
  const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
  if (error) throw new Error(friendly(error));
}

export async function signOut() {
  if (dirty) await syncNow();
  await client.auth.signOut();
}

// Downloads the account's copy, merges it with this device's record by
// record, and uploads the result. The row carries a version number: if
// another device saved in between, the upload is refused and we merge again.
export async function syncNow() {
  if (!session || status.syncing) return;
  status.syncing = true;
  status.error = "";
  notify();
  clearTimeout(timer);
  const userId = session.user.id;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: row, error } = await client.from("progress").select("data, version").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      const before = JSON.stringify(state);
      const merged = mergeStates(JSON.parse(before), row?.data);
      const mergedText = JSON.stringify(merged);
      if (mergedText !== before) {
        replaceState(merged);
        notify(true);
      }
      if (row && mergedText === JSON.stringify(row.data)) { dirty = false; break; }
      if (!row) {
        const { error: e } = await client.from("progress").insert({ user_id: userId, data: merged, version: 1 });
        if (!e) { dirty = false; break; }
        if (e.code !== "23505") throw e; // 23505: another device created the row first
      } else {
        const { data: updated, error: e } = await client.from("progress")
          .update({ data: merged, version: row.version + 1, updated_at: new Date().toISOString() })
          .eq("user_id", userId).eq("version", row.version).select("version");
        if (e) throw e;
        if (updated?.length) { dirty = false; break; }
      }
      if (attempt === 3) throw new Error("Another device kept saving at the same time. Try again in a moment.");
    }
    status.lastSync = Date.now();
  } catch (error) {
    status.error = `Sync failed: ${friendly(error)}`;
  }
  status.syncing = false;
  notify();
}
