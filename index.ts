import { createClient } from "npm:@supabase/supabase-js@2";

// RCX Journal MetaApi bridge. The browser sends only the RCX license session token,
// selected platform/server, and a connection id. Broker credentials are entered by the
// member on MetaApi's hosted configuration page and are never sent to this function.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const text = (v: unknown, max = 160) => String(v ?? "").trim().slice(0, max);
const num = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const PROVISIONING = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const REGION = (Deno.env.get("METAAPI_REGION") || "new-york").trim().toLowerCase();
const CLIENT_API = (Deno.env.get("METAAPI_CLIENT_API_BASE_URL") || `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`).replace(/\/$/, "");

function safeError(input: string) {
  // Avoid showing raw provider responses that might contain personal/account metadata.
  return input.replace(/\b\d{5,}\b/g, "[redacted]").slice(0, 500);
}

async function providerRequest(url: string, method = "GET", body?: unknown, transactionId?: string) {
  const token = Deno.env.get("METAAPI_TOKEN") || "";
  if (!token) throw new Error("ผู้ดูแล RCX ยังไม่ได้ตั้งค่า METAAPI_TOKEN ใน Supabase Secrets");
  const headers: Record<string, string> = { "Accept": "application/json", "auth-token": token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // MetaApi requires transaction-id only for account creation, and the same id must be
  // reused when polling an asynchronous (202 Accepted) create request.
  if (method === "POST" && new URL(url).pathname === "/users/current/accounts") {
    headers["transaction-id"] = transactionId || crypto.randomUUID().replaceAll("-", "");
  }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data: any = null;
  if (raw) { try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 300) }; } }
  if (!response.ok && response.status !== 202) {
    const message = text(data?.message || data?.error || `MetaApi HTTP ${response.status}`, 400);
    throw new Error(safeError(message));
  }
  return { status: response.status, data, retryAfter: response.headers.get("retry-after") || "" };
}

async function validKeyId(admin: ReturnType<typeof createClient>, sessionToken: string) {
  if (!sessionToken || sessionToken.length < 20) throw new Error("เซสชัน RCX ไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  const { data, error } = await admin.rpc("tj_feature_key_id", { p_token: sessionToken });
  if (error) throw new Error("ตรวจสอบ License ไม่สำเร็จ กรุณารัน SQL migration ของ RCX ก่อน");
  if (!data) throw new Error("License หมดอายุหรือเซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  return String(data);
}

async function configurationLink(accountId: string) {
  const result = await providerRequest(`${PROVISIONING}/users/current/accounts/${encodeURIComponent(accountId)}/configuration-link?ttlInDays=1`, "PUT");
  const link = text(result.data?.configurationLink, 2000);
  if (!/^https:\/\/app\.metaapi\.cloud\//i.test(link)) throw new Error("MetaApi ไม่ได้ส่งลิงก์ตั้งค่าที่ถูกต้องกลับมา");
  return link;
}

function toISO(v: unknown): string | null {
  const d = new Date(String(v ?? ""));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function aggregatePositions(deals: Record<string, any>[], connection: Record<string, any>, accountLogin: string, accountCurrency: string) {
  const groups = new Map<string, Record<string, any>[]>();
  for (const d of deals) {
    const pos = text(d.position_id || d.positionId || d.order_id || d.orderId || d.deal_id, 100);
    if (!pos) continue;
    const a = groups.get(pos) || [];
    a.push(d);
    groups.set(pos, a);
  }
  const result: Record<string, any>[] = [];
  for (const [positionId, rows] of groups) {
    rows.sort((a, b) => new Date(a.deal_time).getTime() - new Date(b.deal_time).getTime());
    const entries = rows.filter(d => /DEAL_ENTRY_IN$/.test(String(d.entry_type || "").toUpperCase()));
    const exits = rows.filter(d => /DEAL_ENTRY_(OUT|OUT_BY|INOUT)$/.test(String(d.entry_type || "").toUpperCase()));
    if (!entries.length || !exits.length) continue; // only closed positions become journal rows
    const first = entries[0];
    const sideRaw = String(first.deal_type || "").toUpperCase();
    const side = sideRaw.includes("BUY") ? "BUY" : sideRaw.includes("SELL") ? "SELL" : "";
    if (!side) continue; // ignore deposits/credits/balance events
    const symbol = text(first.symbol, 48).toUpperCase();
    if (!symbol) continue;
    const openVol = entries.reduce((s, d) => s + Math.max(0, num(d.volume)), 0);
    const closeVol = exits.reduce((s, d) => s + Math.max(0, num(d.volume)), 0);
    const avg = (arr: Record<string, any>[]) => {
      const vol = arr.reduce((s, d) => s + Math.max(0, num(d.volume)), 0);
      return vol > 0 ? arr.reduce((s, d) => s + num(d.price) * Math.max(0, num(d.volume)), 0) / vol : num(arr[0]?.price);
    };
    const openTime = toISO(entries[0].deal_time);
    const closeTime = toISO(exits[exits.length - 1].deal_time);
    if (!openTime || !closeTime || new Date(closeTime) < new Date(openTime)) continue;
    const extId = `${connection.id}:${positionId}`;
    result.push({
      key_id: connection.key_id,
      connection_id: connection.id,
      external_id: extId,
      position_id: positionId,
      account_login: accountLogin,
      account_currency: accountCurrency,
      platform: connection.platform,
      symbol,
      side,
      volume: openVol || closeVol,
      open_time: openTime,
      close_time: closeTime,
      open_price: avg(entries),
      close_price: avg(exits),
      profit: rows.reduce((s, d) => s + num(d.profit), 0),
      swap: rows.reduce((s, d) => s + num(d.swap), 0),
      commission: rows.reduce((s, d) => s + num(d.commission), 0),
      updated_at: new Date().toISOString(),
    });
  }
  return result.sort((a, b) => String(a.close_time).localeCompare(String(b.close_time)));
}

async function readAllStoredDeals(admin: ReturnType<typeof createClient>, connectionId: string) {
  const all: Record<string, any>[] = [];
  for (let from = 0; from < 30000; from += 1000) {
    const { data, error } = await admin.from("tj_metaapi_deals")
      .select("deal_id,position_id,order_id,deal_time,entry_type,deal_type,symbol,volume,price,profit,swap,commission,magic")
      .eq("connection_id", connectionId).order("deal_time", { ascending: false }).range(from, from + 999);
    if (error) throw new Error("อ่านประวัติที่เก็บไว้ใน RCX ไม่สำเร็จ");
    const page = data || [];
    all.push(...page);
    if (page.length < 1000) break;
  }
  all.sort((a, b) => new Date(a.deal_time).getTime() - new Date(b.deal_time).getTime());
  return all;
}

async function readDeals(connection: Record<string, any>, admin: ReturnType<typeof createClient>, keyId: string, accountCurrency: string, accountLogin: string) {
  const now = new Date();
  // Initial load: last 365 days. Incremental updates re-read a 3-day overlap to catch broker corrections.
  const last = connection.last_sync_at ? new Date(connection.last_sync_at).getTime() - 3 * 86400000 : now.getTime() - 365 * 86400000;
  const start = new Date(Math.min(last, now.getTime() - 1000));
  let offset = 0;
  let fetched = 0;
  const batchRows: Record<string, any>[] = [];
  while (offset < 10000) {
    const url = `${CLIENT_API}/users/current/accounts/${encodeURIComponent(connection.metaapi_account_id)}/history-deals/time/${encodeURIComponent(start.toISOString())}/${encodeURIComponent(now.toISOString())}?offset=${offset}&limit=1000`;
    const response = await providerRequest(url, "GET");
    const deals = Array.isArray(response.data) ? response.data : Array.isArray(response.data?.deals) ? response.data.deals : null;
    if (!deals) throw new Error("MetaApi ส่งข้อมูลประวัติในรูปแบบที่ไม่รู้จัก");
    for (const d of deals) {
      const id = text(d.id, 100);
      const time = toISO(d.time);
      if (!id || !time) continue;
      batchRows.push({
        key_id: keyId,
        connection_id: connection.id,
        deal_id: id,
        position_id: text(d.positionId || d.position_id, 100),
        order_id: text(d.orderId || d.order_id, 100),
        deal_time: time,
        entry_type: text(d.entryType || d.entry_type, 40).toUpperCase(),
        deal_type: text(d.type || d.deal_type, 40).toUpperCase(),
        symbol: text(d.symbol, 48).toUpperCase(),
        volume: Math.max(0, num(d.volume)),
        price: num(d.price),
        profit: num(d.profit),
        swap: num(d.swap),
        commission: num(d.commission),
        magic: Math.trunc(num(d.magic)),
        raw_data: d,
      });
    }
    fetched += deals.length;
    if (deals.length < 1000) break;
    offset += deals.length;
  }
  for (let i = 0; i < batchRows.length; i += 300) {
    const { error } = await admin.from("tj_metaapi_deals").upsert(batchRows.slice(i, i + 300), { onConflict: "connection_id,deal_id" });
    if (error) throw new Error("บันทึกประวัติดีลเข้า Supabase ไม่สำเร็จ");
  }

  const allDeals = await readAllStoredDeals(admin, connection.id);
  const normalized = aggregatePositions(allDeals, connection, accountLogin, accountCurrency);
  for (let i = 0; i < normalized.length; i += 300) {
    const { error } = await admin.from("tj_metaapi_trades").upsert(normalized.slice(i, i + 300), { onConflict: "connection_id,external_id" });
    if (error) throw new Error("จัดเก็บรายการเทรดที่ปิดแล้วไม่สำเร็จ");
  }
  const { error: stateError } = await admin.from("tj_metaapi_connections").update({
    status: "CONNECTED", last_sync_at: now.toISOString(), last_account_login: accountLogin,
    account_currency: accountCurrency || "USD", last_error: null, updated_at: now.toISOString(),
  }).eq("id", connection.id).eq("key_id", keyId);
  if (stateError) throw new Error("ซิงค์แล้วแต่บันทึกสถานะไม่สำเร็จ");
  return { fetchedDeals: fetched, tradeCount: normalized.length, trades: normalized.slice(-2000), currency: accountCurrency, accountLogin, lastSyncAt: now.toISOString(), limited: fetched >= 10000 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "ใช้ POST เท่านั้น" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  let defaultSecretKey = "";
  try {
    const namedSecrets = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    defaultSecretKey = text(namedSecrets?.default || namedSecrets?.service_role, 500);
  } catch { /* legacy SUPABASE_SERVICE_ROLE_KEY is preferred when available */ }
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || defaultSecretKey;
  if (!supabaseUrl || !serviceKey) return json({ error: "Supabase service environment ยังไม่พร้อม" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "ต้องส่ง JSON" }, 400); }
  let keyId = "";
  try {
    keyId = await validKeyId(admin, text(body.token, 500));
    const action = text(body.action, 40);

    if (action === "list") {
      const { data, error } = await admin.from("tj_metaapi_connections")
        .select("id,platform,server_name,label,status,account_currency,last_account_login,last_sync_at,last_error,created_at,metaapi_account_id,region")
        .eq("key_id", keyId).neq("status", "DISCONNECTED").order("created_at", { ascending: false });
      if (error) throw new Error("ยังติดตั้งตาราง MetaApi ไม่ครบ กรุณารัน SQL migration");
      return json({ ok: true, connections: data || [] });
    }

    if (action === "connect") {
      const platform = text(body.platform, 8).toUpperCase();
      const server = text(body.server, 100);
      const label = text(body.label, 60) || `${platform} account`;
      if (!( ["MT4", "MT5"].includes(platform))) return json({ error: "เลือก MT4 หรือ MT5 ก่อน" }, 400);
      if (server.length < 3 || !/^[A-Za-z0-9 ._()\-]+$/.test(server)) return json({ error: "ใส่ชื่อ Server ให้ตรงกับหน้าล็อกอิน MetaTrader" }, 400);
      if (!Deno.env.get("METAAPI_TOKEN")) return json({ error: "ผู้ดูแล RCX ยังไม่ได้ตั้งค่า METAAPI_TOKEN ใน Supabase Secrets" }, 503);
      const count = await admin.from("tj_metaapi_connections").select("id", { count: "exact", head: true }).eq("key_id", keyId).neq("status", "DISCONNECTED");
      if (count.error) throw new Error("ตรวจจำนวนบัญชีที่เชื่อมอยู่ไม่สำเร็จ");
      if ((count.count || 0) >= 3) return json({ error: "License นี้เชื่อมได้สูงสุด 3 บัญชี กรุณาถอดบัญชีที่ไม่ใช้ก่อน" }, 400);
      const transactionId = crypto.randomUUID().replaceAll("-", "");
      const row = {
        key_id: keyId, metaapi_account_id: null, provider_transaction_id: transactionId,
        platform, server_name: server, label, region: REGION, status: "CONNECTING",
        account_currency: "USD", last_account_login: "", last_error: null, updated_at: new Date().toISOString(),
      };
      const inserted = await admin.from("tj_metaapi_connections").insert(row)
        .select("id,platform,server_name,label,status,created_at,metaapi_account_id,region,provider_transaction_id").single();
      if (inserted.error) throw new Error("บันทึกคำขอเชื่อมต่อใน RCX ไม่สำเร็จ กรุณาตรวจ SQL migration");
      const requestBody = { name: label, server, platform: platform.toLowerCase(), magic: 0, type: "cloud-g2", region: REGION, tags: ["rcx-journal", platform.toLowerCase()] };
      try {
        const created = await providerRequest(`${PROVISIONING}/users/current/accounts`, "POST", requestBody, transactionId);
        const accountId = text(created.data?.id, 100);
        if (!accountId) {
          await admin.from("tj_metaapi_connections").update({ status: "CONNECTING", last_error: null, updated_at: new Date().toISOString() }).eq("id", inserted.data.id).eq("key_id", keyId);
          return json({ ok: true, pendingProvisioning: true, connection: { ...inserted.data, provider_transaction_id: undefined }, retryAfter: created.retryAfter || "", message: text(created.data?.message || "MetaApi กำลังตรวจจับ Broker Server อยู่ กรุณารอสักครู่ แล้วกด Verify & Sync", 300) });
        }
        const updated = await admin.from("tj_metaapi_connections").update({ metaapi_account_id: accountId, provider_transaction_id: null, status: "NEEDS_SETUP", last_error: null, updated_at: new Date().toISOString() }).eq("id", inserted.data.id).eq("key_id", keyId).select("id,platform,server_name,label,status,created_at,metaapi_account_id,region").single();
        if (updated.error) {
          try { await providerRequest(`${PROVISIONING}/users/current/accounts/${encodeURIComponent(accountId)}`, "DELETE"); } catch { /* best effort cleanup */ }
          throw new Error("บันทึก Account ID ใน RCX ไม่สำเร็จ");
        }
        let link = "";
        try { link = await configurationLink(accountId); }
        catch (e) { await admin.from("tj_metaapi_connections").update({ last_error: text((e as Error).message, 400) }).eq("id", inserted.data.id); throw e; }
        return json({ ok: true, connection: updated.data, configurationLink: link, message: "เปิดลิงก์ MetaApi เพื่อกรอกข้อมูลบัญชีอย่างปลอดภัย จากนั้นกลับมา RCX แล้วกด Verify & Sync" });
      } catch (e) {
        await admin.from("tj_metaapi_connections").update({ status: "ERROR", last_error: text((e as Error).message, 400), updated_at: new Date().toISOString() }).eq("id", inserted.data.id).eq("key_id", keyId);
        throw e;
      }
    }

    const connectionId = text(body.connectionId, 80);
    if (!connectionId) return json({ error: "ไม่พบ Connection ID" }, 400);
    const { data: connection, error: connectionError } = await admin.from("tj_metaapi_connections")
      .select("*").eq("id", connectionId).eq("key_id", keyId).maybeSingle();
    if (connectionError) throw new Error("อ่านข้อมูลการเชื่อมต่อไม่สำเร็จ");
    if (!connection || connection.status === "DISCONNECTED") return json({ error: "ไม่พบการเชื่อมต่อนี้" }, 404);

    if (action === "list-trades") {
      if (!connection.metaapi_account_id) return json({ ok: true, trades: [], hasMore: false, offset: 0 });
      const offset = Math.max(0, Math.min(200000, Math.trunc(num(body.offset))));
      const limit = Math.max(1, Math.min(500, Math.trunc(num(body.limit, 500))));
      const { data, error } = await admin.from("tj_metaapi_trades")
        .select("connection_id,external_id,position_id,account_login,account_currency,platform,symbol,side,volume,open_time,close_time,open_price,close_price,profit,swap,commission,updated_at")
        .eq("connection_id", connection.id).eq("key_id", keyId)
        .order("close_time", { ascending: true }).range(offset, offset + limit - 1);
      if (error) throw new Error("อ่านประวัติ Sync จาก Cloud ไม่สำเร็จ");
      const trades = data || [];
      return json({ ok: true, trades, offset, hasMore: trades.length === limit });
    }

    if (action === "setup-link") {
      if (!connection.metaapi_account_id) return json({ error: "MetaApi ยังเตรียมบัญชีไม่เสร็จ ให้กด Sync now เพื่อตรวจสถานะอีกครั้ง" }, 409);
      const link = await configurationLink(connection.metaapi_account_id);
      return json({ ok: true, configurationLink: link });
    }

    if (action === "disconnect") {
      try { if (connection.metaapi_account_id) await providerRequest(`${PROVISIONING}/users/current/accounts/${encodeURIComponent(connection.metaapi_account_id)}`, "DELETE"); } catch (e) {
        // Do not mark disconnected if the provider still reports a failure, except not-found.
        if (!String((e as Error).message).toLowerCase().includes("not found")) throw e;
      }
      const { error } = await admin.from("tj_metaapi_connections").update({ status: "DISCONNECTED", disconnected_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null }).eq("id", connection.id).eq("key_id", keyId);
      if (error) throw new Error("ถอดการเชื่อมต่อฝั่ง RCX ไม่สำเร็จ");
      return json({ ok: true, message: "ถอดการเชื่อมต่อแล้ว ประวัติที่ซิงค์เข้า Journal ไปแล้วจะยังคงอยู่" });
    }

    if (action !== "sync" && action !== "status") return json({ error: "ไม่รู้จักคำสั่งนี้" }, 400);
    if (!connection.metaapi_account_id && connection.provider_transaction_id) {
      const requestBody = { name: connection.label || `${connection.platform} account`, server: connection.server_name, platform: String(connection.platform).toLowerCase(), magic: 0, type: "cloud-g2", region: connection.region || REGION, tags: ["rcx-journal", String(connection.platform).toLowerCase()] };
      const created = await providerRequest(`${PROVISIONING}/users/current/accounts`, "POST", requestBody, connection.provider_transaction_id);
      const accountId = text(created.data?.id, 100);
      if (!accountId) {
        await admin.from("tj_metaapi_connections").update({ status: "CONNECTING", last_error: null, updated_at: new Date().toISOString() }).eq("id", connection.id).eq("key_id", keyId);
        return json({ ok: true, pending: true, pendingProvisioning: true, status: "CONNECTING", message: text(created.data?.message || "MetaApi กำลังตรวจจับ Server อยู่ กรุณารอแล้วลอง Sync now อีกครั้ง", 300), retryAfter: created.retryAfter || "" });
      }
      const updated = await admin.from("tj_metaapi_connections").update({ metaapi_account_id: accountId, provider_transaction_id: null, status: "NEEDS_SETUP", last_error: null, updated_at: new Date().toISOString() }).eq("id", connection.id).eq("key_id", keyId);
      if (updated.error) throw new Error("บันทึก MetaApi Account ID ไม่สำเร็จ");
      const link = await configurationLink(accountId);
      return json({ ok: true, needsConfiguration: true, connectionId: connection.id, configurationLink: link, message: "เตรียมบัญชี Cloud เสร็จแล้ว เปิดลิงก์ MetaApi เพื่อกำหนดบัญชี จากนั้นกลับมากด Verify & Sync" });
    }
    if (!connection.metaapi_account_id) return json({ error: "ยังไม่มี MetaApi Account ID · กดลอง Sync now อีกครั้ง หรือถอดการเชื่อมต่อนี้แล้วเริ่มใหม่" }, 409);
    const accountResult = await providerRequest(`${PROVISIONING}/users/current/accounts/${encodeURIComponent(connection.metaapi_account_id)}`, "GET");
    const providerAccount = accountResult.data || {};
    const providerState = text(providerAccount.state, 40).toUpperCase();
    if (providerState === "DRAFT" || !providerAccount.login) {
      const link = await configurationLink(connection.metaapi_account_id);
      await admin.from("tj_metaapi_connections").update({ status: "NEEDS_SETUP", last_error: null, updated_at: new Date().toISOString() }).eq("id", connection.id);
      return json({ ok: true, needsConfiguration: true, connectionId: connection.id, configurationLink: link, message: "ยังตั้งค่าบัญชีไม่เสร็จ เปิดลิงก์ MetaApi แล้วกรอกข้อมูลบัญชี จากนั้นกลับมาตรวจอีกครั้ง" });
    }
    if (providerState !== "DEPLOYED") {
      if (providerState !== "DEPLOYING") {
        await providerRequest(`${PROVISIONING}/users/current/accounts/${encodeURIComponent(connection.metaapi_account_id)}/deploy`, "POST");
      }
      await admin.from("tj_metaapi_connections").update({ status: "CONNECTING", last_error: null, updated_at: new Date().toISOString() }).eq("id", connection.id);
      return json({ ok: true, pending: true, status: "CONNECTING", message: "บัญชีได้รับการตั้งค่าแล้ว กำลังเปิด Cloud Terminal กรุณารอประมาณ 10–30 วินาทีแล้วกดตรวจอีกครั้ง" });
    }

    const infoUrl = `${CLIENT_API}/users/current/accounts/${encodeURIComponent(connection.metaapi_account_id)}/account-information?refreshTerminalState=false`;
    let accountInfo: any;
    try { accountInfo = (await providerRequest(infoUrl, "GET")).data || {}; }
    catch (e) {
      await admin.from("tj_metaapi_connections").update({ status: "ERROR", last_error: text((e as Error).message, 400), updated_at: new Date().toISOString() }).eq("id", connection.id);
      throw new Error("Cloud Terminal เปิดแล้วแต่ยังอ่าน Account Information ไม่ได้ ตรวจ API region ใน MetaApi แล้วลองใหม่");
    }
    const currency = text(accountInfo.currency || connection.account_currency || "USD", 8).toUpperCase();
    const login = text(accountInfo.login || providerAccount.login || "", 48);
    const result = await readDeals(connection, admin, keyId, currency, login);
    return json({ ok: true, status: "CONNECTED", connectionId: connection.id, ...result, message: result.limited ? "ซิงค์สำเร็จ แต่รอบนี้อ่านได้สูงสุด 10,000 ดีล กรุณาเปิดประวัติในบัญชี MetaTrader ให้ครบแล้วซิงค์อีกครั้งหากต้องการช่วงที่เก่ากว่า" : "ซิงค์ประวัติที่ปิดแล้วสำเร็จ" });
  } catch (error) {
    const message = safeError(String(error instanceof Error ? error.message : error));
    return json({ error: message || "เกิดข้อผิดพลาดระหว่าง MetaApi Sync" }, 400);
  }
});
