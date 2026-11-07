// Lembretes de perfil incompleto. Rodar: node --test test/lembrete.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { missingProfile, reminderDue, profileReminders } from "../worker.js";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const A = "a0000000-0000-4000-8000-000000000001", B = "b0000000-0000-4000-8000-000000000002", C = "c0000000-0000-4000-8000-000000000003";
const ago = (d) => new Date(NOW - d * 864e5).toISOString();

function setup(speakers, { patchFail = [] } = {}) {
  const calls = [], mails = [];
  globalThis.fetch = async (u, init = {}) => {
    u = String(u);
    calls.push({ u, init });
    if (u.startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response("{}"); }
    const m = (init.method || "GET");
    if (u.includes("/rest/v1/speakers?status=eq.draft")) return Response.json(speakers);
    if (u.includes("/rest/v1/speaker_documents")) return Response.json([{ speaker_id: A, front_path: A + "/f.jpg", terms_version: "v1" }]);
    if (u.includes("/rest/v1/profiles")) return Response.json([{ id: A, name: "Ana Silva", email: "ana@x.com" }, { id: B, name: "Bruno", email: "bruno@x.com" }, { id: C, name: "Caio", email: "" }]);
    if (m === "PATCH") {
      const id = u.match(/id=eq\.([0-9a-f-]+)/)[1];
      if (patchFail.includes(id)) return Response.json([]);
      return Response.json([{ id }]);
    }
    return new Response("[]");
  };
  const env = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "srv", RESEND_API_KEY: "re_x", SITE_URL: "https://speakerconnect.com.br" };
  return { env, calls, mails };
}

test("lista só o que falta", () => {
  assert.deepEqual(missingProfile({ photo_url: "x", headline: "h", bio: "b".repeat(90), categories: ["Liderança"], topics: "t", city: "Vitória", fee_from_cents: 100 }, { front_path: "p", terms_version: "v" }), []);
  const m = missingProfile({}, null);
  assert.equal(m.length, 9);
  assert.ok(m[0].startsWith("foto"));
});

test("prazos: 1 dia para o 1º, mais 3 dias para o 2º, nunca o 3º", () => {
  assert.equal(reminderDue({ profile_reminders: 0, created_at: ago(0.5) }, NOW), false);
  assert.equal(reminderDue({ profile_reminders: 0, created_at: ago(1.1) }, NOW), true);
  assert.equal(reminderDue({ profile_reminders: 1, created_at: ago(9), profile_reminded_at: ago(2) }, NOW), false);
  assert.equal(reminderDue({ profile_reminders: 1, created_at: ago(9), profile_reminded_at: ago(3.1) }, NOW), true);
  assert.equal(reminderDue({ profile_reminders: 2, created_at: ago(30), profile_reminded_at: ago(20) }, NOW), false);
});

test("envia para quem está no prazo, com o que falta, e marca antes", async () => {
  const sp = [
    { id: A, public_name: "Ana", photo_url: "x", categories: ["Liderança"], city: "Vitória", created_at: ago(2), profile_reminders: 0 },
    { id: B, public_name: "Bruno", created_at: ago(0.2), profile_reminders: 0 },
    { id: C, public_name: "Caio", created_at: ago(5), profile_reminders: 0 },
  ];
  const { env, calls, mails } = setup(sp);
  const n = await profileReminders(env, NOW);
  assert.equal(n, 1);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["ana@x.com"]);
  assert.match(mails[0].subject, /Falta pouco/);
  assert.match(mails[0].text, /Olá, Ana!/);
  assert.match(mails[0].text, /• título/);
  assert.doesNotMatch(mails[0].text, /• foto\n/);
  assert.doesNotMatch(mails[0].text, /documento/);
  assert.match(mails[0].text, /speakerconnect\.com\.br\/app\/#\/perfil/);
  const iPatch = calls.findIndex((c) => c.init.method === "PATCH"), iMail = calls.findIndex((c) => c.u.startsWith("https://api.resend.com"));
  assert.ok(iPatch > -1 && iPatch < iMail);
  assert.match(calls[iPatch].u, /status=eq\.draft&profile_reminders=eq\.0/);
  assert.deepEqual(JSON.parse(calls[iPatch].init.body).profile_reminders, 1);
});

test("segundo lembrete tem outro assunto", async () => {
  const { env, mails } = setup([{ id: A, public_name: "Ana", created_at: ago(9), profile_reminders: 1, profile_reminded_at: ago(4) }]);
  await profileReminders(env, NOW);
  assert.match(mails[0].subject, /ainda não está no ar/);
});

test("se não conseguir marcar (alguém já mandou ou o perfil mudou), não envia", async () => {
  const { env, mails } = setup([{ id: A, public_name: "Ana", created_at: ago(2), profile_reminders: 0 }], { patchFail: [A] });
  assert.equal(await profileReminders(env, NOW), 0);
  assert.equal(mails.length, 0);
});

test("sem Resend configurado não faz nada", async () => {
  const { env, calls } = setup([{ id: A, created_at: ago(2), profile_reminders: 0 }]);
  delete env.RESEND_API_KEY;
  assert.equal(await profileReminders(env, NOW), 0);
  assert.equal(calls.length, 0);
});

test("agendador chama os lembretes", async () => {
  const { env, mails } = setup([{ id: A, public_name: "Ana", created_at: ago(2), profile_reminders: 0 }]);
  let p; await worker.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p;
  assert.equal(mails.length, 1);
});
