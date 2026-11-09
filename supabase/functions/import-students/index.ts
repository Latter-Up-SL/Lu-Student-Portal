// Supabase Edge Function: import-students
// Lets a signed-in ADMIN prepare Google sign-in accounts in bulk from the admin page.
// Supabase supplies the secret key to this function automatically; you never handle it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ALPHA = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ2346789";
const randomPw = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => ALPHA[b % ALPHA.length]).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only people listed in the admins table may use this.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError) return json({ error: "Sign-in could not be verified." }, 401);
    if (!user?.email) return json({ error: "Not signed in." }, 401);
    const { data: rows, error: adminLookupError } = await admin.from("admins").select("email");
    if (adminLookupError) return json({ error: "Could not verify administrator access." }, 500);
    if (!rows?.some((row) => row.email.trim().toLowerCase() === user.email.trim().toLowerCase())) {
      return json({ error: "Admins only." }, 403);
    }

    const { students } = await req.json();
    if (!Array.isArray(students) || students.length < 1 || students.length > 50) return json({ error: "Send 1 to 50 students at a time." }, 400);

    const results: Record<string, unknown>[] = [];
    for (const s of students) {
      const email = String(s.email ?? "").trim().toLowerCase();
      const name = String(s.name ?? "").trim();
      if (!/^[^@\s]+@latterup\.org$/.test(email)) { results.push({ email, status: "skipped", note: "not an @latterup.org address" }); continue; }
      const attrs = {
        password: randomPw(),
        email_confirm: true,
        ...(name ? { app_metadata: { full_name: name } } : {}),
      };
      const { error } = await admin.auth.admin.createUser({ email, ...attrs });
      if (!error) { results.push({ email, name, status: "created" }); continue; }

      if (/already|exists|registered/i.test(error.message)) {
        results.push({ email, status: "exists", note: "already has an account (left alone)" });
        continue;
      }
      results.push({ email, status: "failed", note: error.message });
    }
    return json({ results });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
