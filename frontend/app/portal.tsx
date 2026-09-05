"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type User = { id: string; name: string; email: string; role: string };
type Model = { id: string };
type Key = { id: string; alias: string; masked: string; models: string[]; rpm_limit: number | null; spend: number; status: string; expires_at?: string | null };
type Msg = { role: "user" | "assistant"; content: string };
type Conversation = { id: string; title: string; model: string; updated_at: string };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!res.ok) throw new Error(data?.detail || data?.error?.message || "خطایی رخ داد");
  return data;
}

function Icon({ name }: { name: string }) {
  const common = { width: 19, height: 19, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></>,
    chat: <><path d="M21 11.5a8 8 0 0 1-8.6 8A8.4 8.4 0 0 1 7 18.6L3 20l1.4-3.5A7.9 7.9 0 0 1 3 12a8 8 0 0 1 18-0.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></>,
    key: <><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 8.5-8.5M15 8l2 2M18 5l1 1"/></>,
    chart: <><path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 4-6"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></>,
    logout: <><path d="M10 5H5v14h5"/><path d="m14 8 4 4-4 4M18 12H9"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    send: <><path d="m4 4 16 8-16 8 4.5-8L4 4Z"/><path d="M8.5 12H20"/></>,
    copy: <><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.8-3L3 10"/><path d="M3 5v5h5"/><path d="M4 13a8 8 0 0 0 14.8 3L21 14"/><path d="M21 19v-5h-5"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

export default function Portal() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState("dashboard");
  const [models, setModels] = useState<Model[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [dashboard, setDashboard] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("Qwen3-32B");
  const [sending, setSending] = useState(false);
  const [keyModal, setKeyModal] = useState(false);
  const [newKey, setNewKey] = useState<any>(null);
  const [formError, setFormError] = useState("");

  const load = async () => {
    try {
      const me = await api("/me");
      setUser(me);
      const [m, k, d, c] = await Promise.all([api("/models"), api("/api-keys"), api("/dashboard"), api("/conversations")]);
      setModels(m.data || []); setKeys(k.data || []); setDashboard(d); setConversations(c.data || []);
      if ((m.data || []).length && !selectedModel) setSelectedModel(m.data[0].id);
    } catch { setUser(null); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  const refreshUsage = async () => {
    try {
      const result = await api("/usage");
      setUsage(result);
      setFormError("");
    } catch (err: any) {
      console.error("Usage request failed:", err);
      setUsage(null);
      setFormError(err?.message || "خطا در دریافت Usage");
    }
  };
  useEffect(() => { if (user && active === "usage") refreshUsage(); }, [user, active]);

  const submitAuth = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setFormError(""); const fd = new FormData(e.currentTarget);
    const body = authMode === "login" ? { email: fd.get("email"), password: fd.get("password") } : { name: fd.get("name"), email: fd.get("email"), password: fd.get("password") };
    try { await api(`/auth/${authMode}`, { method: "POST", body: JSON.stringify(body) }); await load(); } catch (err: any) { setFormError(err.message); }
  };
  const logout = async () => { await api("/auth/logout", { method: "POST" }); setUser(null); };

  const openConversation = async (id: string) => {
    try {
      const result = await api(`/conversations/${id}`);
      setConversationId(id); setMessages((result.data.messages || []).filter((m: any) => m.role !== "system").map((m: any) => ({ role: m.role, content: m.content })));
      setSelectedModel(result.data.model || selectedModel); setActive("chat");
    } catch (err: any) { setFormError(err.message); }
  };
  const newConversation = () => { setConversationId(null); setMessages([]); setInput(""); setActive("chat"); setFormError(""); };
  const ensureConversation = async () => {
    if (conversationId) return conversationId;
    const result = await api("/conversations", { method: "POST", body: JSON.stringify({ model: selectedModel }) });
    const id = result.data.id; setConversationId(id); setConversations((items) => [result.data, ...items]); return id;
  };
  const persistMessage = async (id: string, role: "user" | "assistant", content: string) => {
    await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ role, content }) });
  };

  const sendChat = async () => {
    const text = input.trim(); if (!text || sending) return;
    setSending(true); setInput(""); setFormError("");
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    try {
      const id = await ensureConversation();
      await persistMessage(id, "user", text);
      const res = await fetch("/api/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: selectedModel, messages: next, stream: true, max_tokens: 1200, enable_thinking: false }) });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let assistantText = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n"); buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split("\n").find((l) => l.startsWith("data:")); if (!line) continue;
          const payload = line.slice(5).trim(); if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload); const delta = obj.choices?.[0]?.delta?.content || "";
            if (delta) { assistantText += delta; setMessages((m) => { const copy = [...m]; copy[copy.length - 1] = { role: "assistant", content: assistantText }; return copy; }); }
          } catch {}
        }
      }
      if (assistantText) await persistMessage(id, "assistant", assistantText);
      const refreshed = await api("/conversations"); setConversations(refreshed.data || []);
    } catch (err: any) {
      setMessages((m) => { const copy = [...m]; copy[copy.length - 1] = { role: "assistant", content: `خطا: ${err.message}` }; return copy; });
    } finally { setSending(false); }
  };

  const deleteConversation = async (id: string) => { if (!confirm("این گفتگو حذف شود؟")) return; await api(`/conversations/${id}`, { method: "DELETE" }); if (conversationId === id) newConversation(); setConversations((items) => items.filter((x) => x.id !== id)); };
  const createKey = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setFormError(""); const fd = new FormData(e.currentTarget); try { const data = await api("/api-keys", { method: "POST", body: JSON.stringify({ alias: fd.get("alias"), models: [selectedModel], rpm_limit: Number(fd.get("rpm") || 30), duration: fd.get("duration") || "30d" }) }); setNewKey(data); setKeyModal(false); await load(); } catch (err: any) { setFormError(err.message); } };
  const deleteKey = async (id: string) => { if (!confirm("این کلید لغو شود؟")) return; await api(`/api-keys/${id}`, { method: "DELETE" }); await load(); };
  const rotateKey = async (id: string) => { if (!confirm("کلید فعلی با یک کلید جدید جایگزین شود؟")) return; const data = await api(`/api-keys/${id}/rotate`, { method: "POST" }); setNewKey(data); await load(); };

  const sidebar = useMemo(() => [["dashboard", "داشبورد", "home"], ["chat", "چت", "chat"], ["keys", "کلیدهای API", "key"], ["usage", "مصرف و Usage", "chart"], ["account", "حساب کاربری", "user"]], []);
  if (loading) return <div className="boot"><div className="brand-mark">H</div><div>در حال راه‌اندازی پنل…</div></div>;
  if (!user) return <Auth mode={authMode} setMode={setAuthMode} submit={submitAuth} error={formError} />;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup side-brand"><div className="brand-mark">H</div><div><b>Hinaa</b><span>AI Platform</span></div></div>
      <button className="new-chat" onClick={newConversation}><Icon name="plus"/>گفتگوی جدید</button>
      <nav>{sidebar.map(([id, label, icon]) => <button key={id} className={active === id ? "nav-item active" : "nav-item"} onClick={() => setActive(id)}><Icon name={icon}/><span>{label}</span></button>)}</nav>
      <div className="history-panel"><div className="history-title">گفتگوهای اخیر</div>{conversations.slice(0, 7).map((c) => <div className={`history-item ${conversationId === c.id ? "selected" : ""}`} key={c.id}><button onClick={() => openConversation(c.id)}>{c.title}</button><button className="history-delete" aria-label="حذف" onClick={() => deleteConversation(c.id)}>×</button></div>)}{conversations.length === 0 && <small>هنوز گفتگویی ندارید.</small>}</div>
      <div className="sidebar-bottom"><div className="mini-user"><div className="avatar">{user.name.slice(0,1)}</div><div><b>{user.name}</b><small>{user.email}</small></div></div><button className="logout" onClick={logout}><Icon name="logout"/></button></div>
    </aside>
    <section className="main-panel">
      <header className="topbar"><div><span className="crumb">پنل کاربری</span><h2>{active === "dashboard" ? "داشبورد" : active === "chat" ? "گفتگو" : active === "keys" ? "کلیدهای API" : active === "usage" ? "مصرف و Usage" : "حساب کاربری"}</h2></div><div className="status"><i/> سرویس فعال</div></header>
      {active === "dashboard" && <Dashboard user={user} data={dashboard} keys={keys} onChat={newConversation} onKeys={() => setActive("keys")} />}
      {active === "chat" && <Chat selectedModel={selectedModel} setSelectedModel={setSelectedModel} models={models} messages={messages} input={input} setInput={setInput} sendChat={sendChat} sending={sending} onNew={newConversation} />}
      {active === "keys" && <Keys keys={keys} models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} deleteKey={deleteKey} rotateKey={rotateKey} openModal={() => setKeyModal(true)} newKey={newKey} setNewKey={setNewKey} />}
      {active === "usage" && <Usage keys={keys} data={usage} />}
      {active === "account" && <Account user={user} />}
    </section>
    {keyModal && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h3>ساخت کلید API</h3><button onClick={() => setKeyModal(false)}>×</button></div><form className="form-stack" onSubmit={createKey}><label>نام کلید<input name="alias" required placeholder="Production App" /></label><label>مدل<input value={selectedModel} readOnly /></label><label>محدودیت RPM<input name="rpm" type="number" defaultValue={30} min={1} /></label><label>انقضا<select name="duration" defaultValue="30d"><option value="30d">۳۰ روز</option><option value="90d">۹۰ روز</option><option value="365d">۱ سال</option><option value="">بدون انقضا</option></select></label>{formError && <div className="error-box">{formError}</div>}<button className="primary" type="submit">ایجاد کلید</button></form></div></div>}
  </main>;
}

function Auth({ mode, setMode, submit, error }: any) { return <main className="auth-shell"><section className="auth-card"><div className="brand-lockup"><div className="brand-mark large">H</div><div><b>Hinaa</b><span>هوش مصنوعی حرفه‌ای</span></div></div><h1>{mode === "login" ? "خوش آمدید" : "ساخت حساب کاربری"}</h1><p className="muted">دسترسی به چت و سرویس‌های هوش مصنوعی Hinaa</p><form onSubmit={submit} className="form-stack">{mode === "register" && <label>نام<input name="name" required placeholder="نام شما" /></label>}<label>ایمیل<input name="email" type="email" required placeholder="you@example.com" /></label><label>رمز عبور<input name="password" type="password" minLength={8} required placeholder="حداقل ۸ کاراکتر" /></label>{error && <div className="error-box">{error}</div>}<button className="primary full" type="submit">{mode === "login" ? "ورود" : "ثبت‌نام"}</button></form><button className="link-btn" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "حساب دارید؟ وارد شوید"}</button></section></main>; }
function Dashboard({ user, data, keys, onChat, onKeys }: any) { return <div className="content"><div className="hero"><div><div className="eyebrow">HINAA AI</div><h1>سلام {user.name} 👋</h1><p>همه‌چیز برای شروع یک تجربه حرفه‌ای با هوش مصنوعی آماده است.</p></div><button className="primary" onClick={onChat}><Icon name="chat"/>شروع گفتگو</button></div><div className="stat-grid"><Stat title="مدل فعال" value={data?.models?.[0] || "Qwen3-32B"}/><Stat title="کلیدهای فعال" value={data?.keys ?? keys.length}/><Stat title="هزینه ثبت‌شده" value={`$${Number(data?.spend || 0).toFixed(4)}`}/></div><div className="section-head"><h3>دسترسی سریع</h3></div><div className="quick-grid"><button onClick={onChat}><Icon name="chat"/><b>چت با هوش مصنوعی</b><span>گفتگوی سریع و مستقیم</span></button><button onClick={onKeys}><Icon name="key"/><b>مدیریت API Key</b><span>ساخت و مدیریت کلید سرویس</span></button></div></div>; }
function Stat({ title, value }: { title: string; value: string | number }) { return <div className="stat"><small>{title}</small><strong>{value}</strong><span>وضعیت فعلی</span></div>; }
function Chat({ selectedModel, setSelectedModel, models, messages, input, setInput, sendChat, sending, onNew }: any) { const end = useRef<HTMLDivElement>(null); useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]); return <div className="chat-view"><div className="chat-head"><div><h3>{messages.length ? "گفتگو" : "گفتگوی جدید"}</h3><span>پاسخ‌ها توسط مدل انتخاب‌شده تولید می‌شوند.</span></div><div className="chat-tools"><select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>{models.map((m: Model) => <option key={m.id}>{m.id}</option>)}</select><button className="secondary" onClick={onNew}>گفتگوی جدید</button></div></div><div className="messages">{messages.length === 0 ? <div className="empty-chat"><div className="brand-mark large">H</div><h2>چطور می‌توانم کمک کنم؟</h2><p>سؤال خود را به فارسی بنویسید.</p><div className="suggestions"><button onClick={() => setInput("یک متن حرفه‌ای برای معرفی محصول بنویس")}>معرفی محصول</button><button onClick={() => setInput("این کد را بررسی و بهینه کن")}>بررسی کد</button><button onClick={() => setInput("یک برنامه کاری هفتگی پیشنهاد بده")}>برنامه‌ریزی</button></div></div> : messages.map((m: Msg, i: number) => <div key={i} className={`message ${m.role}`}><div className="bubble">{m.content || (sending && i === messages.length - 1 ? "در حال فکر کردن…" : "")}</div></div>)}<div ref={end}/></div><div className="composer"><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} placeholder="پیام خود را بنویسید…"/><button className="send-btn" onClick={sendChat} disabled={sending || !input.trim()}><Icon name="send"/></button><div className="composer-hint">Enter برای ارسال · Shift+Enter برای خط جدید</div></div></div>; }
function Keys({ keys, models, selectedModel, setSelectedModel, deleteKey, rotateKey, openModal, newKey, setNewKey }: any) { return <div className="content"><div className="page-intro"><div><div className="eyebrow">API CENTER</div><h1>کلیدهای API</h1><p>کلیدهای دسترسی خود را مدیریت کنید و هر کلید را به مدل‌های مجاز محدود کنید.</p></div><button className="primary" onClick={openModal}><Icon name="plus"/>ساخت کلید جدید</button></div><div className="toolbar"><label>مدل پیش‌فرض برای کلید جدید<select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>{models.map((m: Model) => <option key={m.id}>{m.id}</option>)}</select></label></div>{newKey && <div className="reveal"><div><b>کلید جدید ایجاد شد</b><p>این مقدار را همین حالا کپی و در محل امن نگهداری کنید.</p><code>{newKey.key}</code></div><button onClick={() => navigator.clipboard?.writeText(newKey.key)}><Icon name="copy"/>کپی</button><button onClick={() => setNewKey(null)}>×</button></div>}<div className="key-grid">{keys.map((k: Key) => <div className="key-card" key={k.id}><div className="key-top"><div className="key-icon"><Icon name="key"/></div><div><b>{k.alias}</b><small>{k.masked}</small></div><span className={`pill ${k.status}`}>{k.status === "active" ? "فعال" : "لغو شده"}</span></div><div className="key-meta"><div><small>مدل</small><strong>{k.models.join("، ")}</strong></div><div><small>RPM</small><strong>{k.rpm_limit ?? "—"}</strong></div><div><small>مصرف</small><strong>${Number(k.spend || 0).toFixed(4)}</strong></div></div><div className="key-actions"><button onClick={() => rotateKey(k.id)}><Icon name="refresh"/>چرخش</button><button className="danger" onClick={() => deleteKey(k.id)}><Icon name="trash"/>لغو کلید</button></div></div>)}</div>{keys.length === 0 && <div className="empty-card"><h3>هنوز کلیدی ندارید</h3><p>اولین کلید API خود را بسازید.</p><button className="primary" onClick={openModal}>ساخت اولین کلید</button></div>}</div>; }
function Usage({ keys, data }: any) {
  const rows = Array.isArray(data?.keys) ? data.keys : keys;
  const activeKeys = keys.filter((k: Key) => k.status === "active").length;
  const totalSpend = Number(data?.total_spend ?? data?.spend ?? 0);
  const messageCount = data?.messages ?? "—";

  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <div className="eyebrow">USAGE</div>
          <h1>مصرف و Usage</h1>
          <p>نمای کلی مصرف سرویس‌های فعال شما.</p>
        </div>
      </div>

      <div className="stat-grid">
        <Stat title="کلیدهای فعال" value={activeKeys} />
        <Stat title="هزینه ثبت‌شده" value={`$${totalSpend.toFixed(4)}`} />
        <Stat title="پیام‌ها" value={messageCount} />
      </div>

      <div className="info-card">
        <h3>گزارش مصرف هر کلید</h3>

        {rows.length === 0 ? (
          <p className="muted">هنوز API Key فعالی ثبت نشده است.</p>
        ) : (
          rows.map((k: any) => {
            const spend = Number(k.spend || 0);
            const width = Math.min(100, spend * 1000);

            return (
              <div className="usage-row" key={k.id}>
                <span>{k.alias}</span>
                <div className="bar">
                  <i style={{ width: `${width}%` }} />
                </div>
                <b>${spend.toFixed(4)}</b>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
function Account({ user }: any) { return <div className="content"><div className="page-intro"><div><div className="eyebrow">ACCOUNT</div><h1>حساب کاربری</h1><p>اطلاعات پایه حساب شما.</p></div></div><div className="profile-card"><div className="avatar huge">{user.name.slice(0, 1)}</div><div><h3>{user.name}</h3><p>{user.email}</p><span className="pill active">کاربر</span></div></div><div className="info-card"><h3>امنیت</h3><p>رمز عبور و نشست‌های حساب در این بخش به‌صورت امن مدیریت خواهند شد.</p></div></div>; }
