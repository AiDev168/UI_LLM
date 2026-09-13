"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "pending" | "active" | "disabled" | "rejected";
  chat_enabled: boolean;
  api_enabled: boolean;
  mlops_enabled: boolean;
  must_change_password: boolean;
};
type Model = { id: string };

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "Qwen3-VL-30B-A3B-Instruct": "TaHa1_VL",
};

const getModelDisplayName = (modelId: string): string =>
  MODEL_DISPLAY_NAMES[modelId] || modelId;
type Key = { id: string; alias: string; masked: string; models: string[]; rpm_limit: number | null; spend: number; max_budget?: number | null; remaining_budget?: number | null; budget_duration?: string | null; budget_reset_at?: string | null; status: string; expires_at?: string | null };
type Attachment = { id: string; name: string; mime: string; size: number; parts: any[] };
type Msg = { role: "user" | "assistant"; content: string; id?: string; attachments?: { name: string; mime: string }[] };
type Conversation = { id: string; title: string; model: string; updated_at: string };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!res.ok) throw new Error(data?.detail || data?.error?.message || `HTTP ${res.status}`);
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
    stop: <><rect x="7" y="7" width="10" height="10" rx="2"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z"/>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function InlineMarkdown({ text }: { text: string }) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\)]+\))/g).filter(Boolean);
  return <>{tokens.map((token, i) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={i}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={i}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("*") && token.endsWith("*")) return <em key={i}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <span key={i}>{token}</span>;
  })}</>;
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let codeMode = false;
  let lang = "";
  let code: string[] = [];
  let list: string[] = [];
  const flushList = () => { if (!list.length) return; blocks.push(<ul key={`ul-${blocks.length}`}>{list.map((x, i) => <li key={i}><InlineMarkdown text={x}/></li>)}</ul>); list = []; };
  const flushCode = () => { if (!codeMode) return; blocks.push(<pre key={`pre-${blocks.length}`}><code data-lang={lang}>{code.join("\n")}</code></pre>); code = []; lang = ""; codeMode = false; };
  lines.forEach((line, index) => {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) { if (codeMode) flushCode(); else { flushList(); codeMode = true; lang = fence[1] || "text"; } return; }
    if (codeMode) { code.push(line); return; }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) { list.push(item[1]); return; }
    flushList();
    if (!line.trim()) return;
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { const level = heading[1].length; const Tag = (`h${level}`) as any; blocks.push(<Tag key={`h-${index}`}><InlineMarkdown text={heading[2]}/></Tag>); return; }
    blocks.push(<p key={`p-${index}`}><InlineMarkdown text={line}/></p>);
  });
  flushList(); flushCode();
  return <div className="markdown">{blocks}</div>;
}

export default function Portal() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState("chat");

  const [models, setModels] = useState<Model[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [dashboard, setDashboard] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [sending, setSending] = useState(false);
  const [keyModal, setKeyModal] = useState(false);
  const [newKey, setNewKey] = useState<any>(null);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [forcePasswordChange, setForcePasswordChange] = useState(false);

  const notify = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 2800);
  };
  const [theme, setTheme] = useState<"dark" | "light" | "midnight" | "ocean" | "glass" | "paper">("dark");
  useEffect(() => {
    const saved = window.localStorage.getItem("hinaa-theme");
    if (saved && ["dark","light","midnight","ocean","glass","paper"].includes(saved)) {
      setTheme(saved as typeof theme);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const themes: Record<string, Record<string, string>> = {
      dark:      { bg:"#101010", panel:"#171717", text:"#f5f5f5", muted:"#929292", line:"#2b2b2b", accent:"#eaeaea", danger:"#ff6868", success:"#67d69e" },
      light:     { bg:"#f5f6f8", panel:"#ffffff", text:"#16181d", muted:"#68707d", line:"#d9dce2", accent:"#17191e", danger:"#c43e4d", success:"#2f855a" },
      midnight: { bg:"#080d1a", panel:"#0f172a", text:"#edf3ff", muted:"#8da1c0", line:"#1f2c45", accent:"#7dd3fc", danger:"#ff7777", success:"#67e8b0" },
      ocean:    { bg:"#07151a", panel:"#0d2329", text:"#edfafa", muted:"#8eb8bf", line:"#1b3b43", accent:"#5eead4", danger:"#ff8585", success:"#6ee7b7" },
      glass:    { bg:"#090b10", panel:"rgba(26,31,42,.68)", text:"#f4f6fb", muted:"#a6adbd", line:"rgba(255,255,255,.11)", accent:"#c4b5fd", danger:"#ff8585", success:"#86efac" },
      paper:    { bg:"#f5f1e8", panel:"#fffdf8", text:"#24221e", muted:"#746e63", line:"#ddd5c7", accent:"#b08a5a", danger:"#b84a56", success:"#4c8a68" },
    };
    const t = themes[theme] || themes.dark;
    root.dataset.theme = theme;
    root.style.setProperty("--bg", t.bg);
    root.style.setProperty("--panel", t.panel);
    root.style.setProperty("--text", t.text);
    root.style.setProperty("--muted", t.muted);
    root.style.setProperty("--line", t.line);
    root.style.setProperty("--accent", t.accent);
    root.style.setProperty("--danger", t.danger);
    root.style.setProperty("--success", t.success);
    root.style.setProperty("--surface", t.panel);
    root.style.setProperty("--surface-2", theme === "light" ? "#f0f1f4" : t.panel);
    root.style.setProperty("--border", t.line);
    root.style.setProperty("--fg", t.text);
    root.style.setProperty("--muted-fg", t.muted);
    root.style.setProperty("--input", theme === "light" || theme === "paper" ? t.panel : t.bg);
    root.style.setProperty("--button", t.accent);
    root.style.setProperty("--button-fg", theme === "light" || theme === "paper" ? "#ffffff" : t.bg);
    window.localStorage.setItem("hinaa-theme", theme);
  }, [theme]);
  useEffect(() => {
    const saved = window.localStorage.getItem("hinaa-theme");
    if (saved && ["dark","light","midnight","ocean","glass","paper"].includes(saved)) {
      setTheme(saved as typeof theme);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const themes: Record<string, Record<string, string>> = {
      dark:      { bg:"#101010", panel:"#171717", text:"#f5f5f5", muted:"#929292", line:"#2b2b2b", accent:"#eaeaea", danger:"#ff6868", success:"#67d69e" },
      light:     { bg:"#f5f6f8", panel:"#ffffff", text:"#16181d", muted:"#68707d", line:"#d9dce2", accent:"#17191e", danger:"#c43e4d", success:"#2f855a" },
      midnight: { bg:"#080d1a", panel:"#0f172a", text:"#edf3ff", muted:"#8da1c0", line:"#1f2c45", accent:"#7dd3fc", danger:"#ff7777", success:"#67e8b0" },
      ocean:    { bg:"#07151a", panel:"#0d2329", text:"#edfafa", muted:"#8eb8bf", line:"#1b3b43", accent:"#5eead4", danger:"#ff8585", success:"#6ee7b7" },
      glass:    { bg:"#090b10", panel:"rgba(26,31,42,.68)", text:"#f4f6fb", muted:"#a6adbd", line:"rgba(255,255,255,.11)", accent:"#c4b5fd", danger:"#ff8585", success:"#86efac" },
      paper:    { bg:"#f5f1e8", panel:"#fffdf8", text:"#24221e", muted:"#746e63", line:"#ddd5c7", accent:"#b08a5a", danger:"#b84a56", success:"#4c8a68" },
    };
    const t = themes[theme] || themes.dark;
    root.dataset.theme = theme;
    root.style.setProperty("--bg", t.bg);
    root.style.setProperty("--panel", t.panel);
    root.style.setProperty("--text", t.text);
    root.style.setProperty("--muted", t.muted);
    root.style.setProperty("--line", t.line);
    root.style.setProperty("--accent", t.accent);
    root.style.setProperty("--danger", t.danger);
    root.style.setProperty("--success", t.success);
    root.style.setProperty("--surface", t.panel);
    root.style.setProperty("--surface-2", theme === "light" ? "#f0f1f4" : t.panel);
    root.style.setProperty("--border", t.line);
    root.style.setProperty("--fg", t.text);
    root.style.setProperty("--muted-fg", t.muted);
    root.style.setProperty("--input", theme === "light" || theme === "paper" ? t.panel : t.bg);
    root.style.setProperty("--button", t.accent);
    root.style.setProperty("--button-fg", theme === "light" || theme === "paper" ? "#ffffff" : t.bg);
    window.localStorage.setItem("hinaa-theme", theme);
  }, [theme]);

  const abortRef = useRef<AbortController | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const me = await api("/me");
      setUser(me);
      setForcePasswordChange(Boolean(me.must_change_password));
      if (me.must_change_password) {
        setModels([]); setKeys([]); setDashboard(null); setConversations([]); setHistoryAvailable(false);
        return;
      }

      const [m, k, d, c] = await Promise.allSettled([
        api("/models"),
        me.role === "admin" || me.api_enabled ? api("/api-keys") : Promise.reject(new Error("API disabled")),
        api("/dashboard"),
        me.role === "admin" || me.chat_enabled ? api("/conversations") : Promise.reject(new Error("Chat disabled")),
      ]);

      const modelsResult = m.status === "fulfilled" ? m.value : null;
      const keysResult = k.status === "fulfilled" ? k.value : null;
      const dashboardResult = d.status === "fulfilled" ? d.value : null;
      const conversationsResult = c.status === "fulfilled" ? c.value : null;

      setModels(modelsResult?.data || []);
      setKeys(keysResult?.data || []);
      setDashboard(dashboardResult);
      setSelectedModel((current) => current || modelsResult?.data?.[0]?.id || "Qwen3-VL-30B-A3B-Instruct");
      setConversations(conversationsResult?.data || []);
      setHistoryAvailable(Boolean(conversationsResult));
    } catch {
      setUser(null);
      setForcePasswordChange(false);
    } finally {
      setLoading(false);
    }
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
  useEffect(() => { const el = document.querySelector(".main-panel"); if (el) el.scrollTop = 0; }, [active]);

  const submitAuth = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setFormError("");
    const fd = new FormData(e.currentTarget);
    const body = authMode === "login"
      ? { email: fd.get("email"), password: fd.get("password") }
      : { name: fd.get("name"), email: fd.get("email"), password: fd.get("password") };
    try {
      const result = await api(`/auth/${authMode}`, { method: "POST", body: JSON.stringify(body) });
      if (authMode === "register" && result?.pending) {
        setAuthMode("login");
        setFormError(result.message || "درخواست ثبت‌نام شما ثبت شد و پس از تأیید مدیر فعال خواهد شد.");
        return;
      }
      await load();
    } catch (err: any) {
      setFormError(err.message);
    }
  };
  const logout = async () => { try { await api("/auth/logout", { method: "POST" }); } finally { setUser(null); } };
  const changePassword = async (currentPassword: string, newPassword: string) => {
    await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    await load();
    setFormError("");
    notify("رمز عبور با موفقیت تغییر کرد");
  };

  const newConversation = () => { abortRef.current?.abort(); setConversationId(null); setMessages([]); setInput(""); setEditingIndex(null); setFormError(""); setActive("chat"); };
  const openConversation = async (id: string) => { if (!historyAvailable) return; try { const result = await api(`/conversations/${id}`); const raw = result.data.messages || []; setConversationId(id); setMessages(raw.filter((m: any) => m.role !== "system").map((m: any, i: number) => ({ role: m.role, content: m.content, id: m.id || `${id}-${i}` }))); setSelectedModel(result.data.model || selectedModel); setEditingIndex(null); setFormError(""); setActive("chat"); } catch (err: any) { setFormError(err.message); } };
  const ensureConversation = async () => { if (conversationId || !historyAvailable) return conversationId; try { const result = await api("/conversations", { method: "POST", body: JSON.stringify({ model: selectedModel }) }); const id = result.data.id; setConversationId(id); setConversations((items) => [result.data, ...items]); return id; } catch { setHistoryAvailable(false); return null; } };
  const persistMessage = async (id: string | null, role: "user" | "assistant", content: string) => { if (!id || !historyAvailable) return; try { await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ role, content }) }); } catch { setHistoryAvailable(false); } };

  const streamChat = async (
    chatMessages: Array<{ role: "user" | "assistant"; content: any }>,
    id: string | null,
    persistAssistant = true
  ) => {
    const controller = new AbortController();
    abortRef.current = controller;

    /*
     * Qwen3-VL-30B-A3B-Instruct is running with:
     *
     *   --max-model-len 32768
     *
     * We therefore calculate the output budget from the actual
     * conversation size instead of using an artificial fixed limit.
     *
     * The token estimator is intentionally conservative because
     * Persian text, English text, JSON and multimodal content do
     * not have the same characters/token ratio.
     */
    const CONTEXT_LIMIT = 32768;
    const SAFETY_RESERVE = 768;
    const ABSOLUTE_MAX_OUTPUT = 24576;

    const estimateTokens = (value: unknown): number => {
      if (typeof value === "string") {
        return Math.max(1, Math.ceil(value.length / 3));
      }

      if (Array.isArray(value)) {
        return value.reduce(
          (total, item) => total + estimateTokens(item),
          0
        );
      }

      if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;

        // IMPORTANT: media URLs contain base64 data. Their byte length is
        // NOT their model-token count. Counting the raw data URL here can
        // make a single image look like millions of tokens and reduce
        // max_tokens to 1, which breaks multimodal answers.
        if (item.type === "image_url" && item.image_url) {
          return 4096;
        }

        if (item.type === "video_url" && item.video_url) {
          return 8192;
        }

        if (item.type === "text" && typeof item.text === "string") {
          return Math.max(1, Math.ceil(item.text.length / 3));
        }

        return Object.entries(item).reduce(
          (total, [key, child]) =>
            total + (
              key === "url" &&
              typeof child === "string" &&
              child.startsWith("data:")
                ? 0
                : estimateTokens(child)
            ),
          0
        );
      }

      return 0;
    };

    const estimateMessageTokens = (
      messages: Array<{ role: string; content: any }>
    ) => {
      return messages.reduce((total, message) => {
        /*
         * Small allowance for role/message framing tokens.
         */
        return (
          total +
          8 +
          estimateTokens(message.role) +
          estimateTokens(message.content)
        );
      }, 0);
    };

    const calculateMaxTokens = (
      messages: Array<{ role: string; content: any }>
    ) => {
      const inputTokens = estimateMessageTokens(messages);

      const available = Math.max(
        1,
        CONTEXT_LIMIT -
          inputTokens -
          SAFETY_RESERVE
      );

      return Math.max(
        1,
        Math.min(
          ABSOLUTE_MAX_OUTPUT,
          available
        )
      );
    };

    /*
     * Keep the text visible progressively without forcing a React
     * render for every tiny SSE fragment. requestAnimationFrame gives
     * the browser a smooth ChatGPT-like rendering cadence.
     */
    let assistantText = "";
    let pendingRender = false;

    const renderAssistant = () => {
      if (pendingRender) return;

      pendingRender = true;

      requestAnimationFrame(() => {
        pendingRender = false;

        setMessages((messages) => {
          if (!messages.length) {
            return messages;
          }

          const copy = [...messages];

          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            role: "assistant",
            content: assistantText
          };

          return copy;
        });
      });
    };

    /*
     * Send one streaming request.
     *
     * Returns:
     *   finishReason = "length" when the model reached its output
     *   limit and another continuation may be necessary.
     */
    const streamRequest = async (
      messages: Array<{
        role: "user" | "assistant";
        content: any;
      }>
    ): Promise<{
      finishReason: string | null;
    }> => {
      const maxTokens = calculateMaxTokens(messages);

      const res = await fetch("/api/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedModel,
          messages,
          stream: true,
          max_tokens: maxTokens,
          enable_thinking: false
        })
      });

      if (!res.ok || !res.body) {
        throw new Error(await res.text());
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let finishReason: string | null = null;

      const processEvent = (event: string) => {
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"));

        for (const line of dataLines) {
          const payload = line.slice(5).trim();

          if (!payload || payload === "[DONE]") {
            continue;
          }

          try {
            const obj = JSON.parse(payload);
            const choice = obj.choices?.[0];

            if (!choice) {
              continue;
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta?.content;

            if (typeof delta === "string" && delta) {
              assistantText += delta;
              renderAssistant();
            }
          } catch {
            /*
             * An incomplete JSON fragment stays in the SSE buffer
             * and is parsed when the next network chunk arrives.
             */
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, {
          stream: true
        });

        /*
         * Normalize SSE line endings.
         */
        buffer = buffer.replace(/\r\n/g, "\n");

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          processEvent(event);
        }
      }

      /*
       * Flush a final partial UTF-8 sequence.
       */
      buffer += decoder.decode();

      if (buffer.trim()) {
        processEvent(buffer);
      }

      /*
       * Make sure the final text is rendered even if the stream
       * finished between animation frames.
       */
      setMessages((messages) => {
        if (!messages.length) {
          return messages;
        }

        const copy = [...messages];

        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          role: "assistant",
          content: assistantText
        };

        return copy;
      });

      return { finishReason };
    };

    /*
     * Send exactly one streaming request.
     *
     * Automatic multi-request continuation is intentionally disabled.
     * Re-sending a generated assistant response as a new prompt can
     * cause repetition/degeneration with Qwen3-VL, especially when
     * the response reaches the context boundary.
     *
     * The request already receives the largest safe output budget
     * calculated from the current conversation.
     */
    const result = await streamRequest(chatMessages);

    if (result.finishReason === "length") {
      /*
       * The model reached the safe generation boundary.
       * Keep the generated answer as-is instead of starting a
       * continuation loop that can corrupt the response.
       */
    }

    if (pendingRender) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    if (persistAssistant && assistantText) {
      await persistMessage(
        id,
        "assistant",
        assistantText
      );
    }

    if (historyAvailable && id) {
      try {
        const refreshed = await api("/conversations");
        setConversations(refreshed.data || []);
      } catch {
        setHistoryAvailable(false);
      }
    }

    return assistantText;
  };

  const prepareFile = async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", file);

    const res = await fetch("/api/files/prepare", {
      method: "POST",
      body: form
    });

    const text = await res.text();
    let data: any = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text };
    }

    if (!res.ok) {
      throw new Error(
        data?.detail ||
        data?.error?.message ||
        `HTTP ${res.status}`
      );
    }

    return {
      id: crypto.randomUUID(),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      parts: data?.parts || []
    };
  };

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || sending) return;

    setFormError("");

    try {
      const files = Array.from(fileList);

      if (!files.length) {
        return;
      }

      const prepared: Attachment[] = [];

      for (const file of files) {
        if (file.size === 0) {
          throw new Error(`فایل «${file.name}» خالی است.`);
        }

        const item = await prepareFile(file);
        if (!prepared.some((x) => x.name === item.name && x.size === item.size && x.mime === item.mime)) {
          prepared.push(item);
        }
      }

      setAttachments((current) => {
        const existing = new Set(
          current.map((x) => `${x.name}|${x.size}|${x.mime}`)
        );

        return [
          ...current,
          ...prepared.filter(
            (x) => !existing.has(`${x.name}|${x.size}|${x.mime}`)
          )
        ];
      });
    } catch (err: any) {
      setFormError(err?.message || "افزودن فایل ناموفق بود");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((x) => x.id !== id));
  };

  const sendChat = async () => {
    const text = input.trim();
    const pendingAttachments = attachments;

    if ((!text && pendingAttachments.length === 0) || sending || !selectedModel) {
      return;
    }

    setSending(true);
    setInput("");
    setFormError("");

    const base = editingIndex === null ? messages : messages.slice(0, editingIndex);

    const attachmentSummary = pendingAttachments.map((a) => ({
      name: a.name,
      mime: a.mime
    }));

    const userDisplayText = text;
    const historyDisplayText =
      text ||
      (attachmentSummary.length
        ? attachmentSummary.map((a) => `📎 ${a.name}`).join("\n")
        : "فایل پیوست شد");

    const next = [
      ...base,
      {
        role: "user" as const,
        content: userDisplayText,
        attachments: attachmentSummary
      }
    ];

    setMessages([
      ...next,
      { role: "assistant", content: "" }
    ]);

    const wasEdit = editingIndex !== null;
    setEditingIndex(null);

    try {
      const id = await ensureConversation();

      if (id) {
        await persistMessage(id, "user", historyDisplayText);
      }

      const modelMessages: Array<{ role: "user" | "assistant"; content: any }> =
        base.map(({ role, content }) => ({ role, content }));

      const contentParts: any[] = [];

      if (text) {
        contentParts.push({
          type: "text",
          text
        });
      }

      for (const attachment of pendingAttachments) {
        contentParts.push(...attachment.parts);
      }

      modelMessages.push({
        role: "user",
        content: contentParts
      });

      setAttachments([]);
      await streamChat(modelMessages, id);

      if (wasEdit && id) {
        setFormError("پیام ویرایش‌شده به‌عنوان درخواست جدید پاسخ داده شد.");
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setMessages((m) => m[m.length - 1]?.content ? m : m.slice(0, -1));
      } else {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: `خطا: ${err.message}`
          };
          return copy;
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const regenerate = async (index: number) => {
    if (sending || index < 1 || messages[index]?.role !== "assistant" || messages[index - 1]?.role !== "user") return;
    setSending(true); setFormError(""); const next = messages.slice(0, index); setMessages([...next, { role: "assistant", content: "" }]);
    try { await streamChat(next, conversationId, true); } catch (err: any) { if (err?.name !== "AbortError") setMessages((m) => { const copy = [...m]; copy[copy.length - 1] = { role: "assistant", content: `خطا: ${err.message}` }; return copy; }); }
    finally { setSending(false); abortRef.current = null; }
  };
  const stopGeneration = () => abortRef.current?.abort();
  const editMessage = (index: number) => { const msg = messages[index]; if (msg?.role === "user" && !sending) { setInput(msg.content); setEditingIndex(index); } };

  const deleteConversation = async (id: string) => { if (!historyAvailable || !confirm("این گفتگو حذف شود؟")) return; try { await api(`/conversations/${id}`, { method: "DELETE" }); if (conversationId === id) newConversation(); setConversations((items) => items.filter((x) => x.id !== id)); } catch (err: any) { setFormError(err.message); } };
  const createKey = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setFormError(""); const fd = new FormData(e.currentTarget); try { const data = await api("/api-keys", { method: "POST", body: JSON.stringify({ alias: fd.get("alias"), models: [selectedModel], rpm_limit: Number(fd.get("rpm") || 30), duration: fd.get("duration") || "30d", max_budget: fd.get("max_budget") ? Number(fd.get("max_budget")) : null, budget_duration: fd.get("budget_duration") || "30d" }) }); setNewKey(data); setKeyModal(false); notify("کلید API با موفقیت ایجاد شد"); await load(); window.setTimeout(() => document.querySelector(".reveal")?.scrollIntoView({ behavior: "smooth", block: "center" }), 180); window.setTimeout(() => document.querySelector(".reveal")?.scrollIntoView({ behavior: "smooth", block: "center" }), 150); } catch (err: any) { setFormError(err.message); } };
  const deleteKey = async (id: string) => { if (!confirm("این کلید لغو شود؟")) return; try { await api(`/api-keys/${id}`, { method: "DELETE" }); await load(); } catch (err: any) { setFormError(err.message); } };
  const rotateKey = async (id: string) => { if (!confirm("کلید فعلی با یک کلید جدید جایگزین شود؟")) return; try { const data = await api(`/api-keys/${id}/rotate`, { method: "POST" }); setNewKey(data); notify("کلید API با موفقیت چرخانده شد"); await load(); } catch (err: any) { setFormError(err.message); } };

  const sidebar = useMemo(() => { const items: any[] = [["dashboard", "داشبورد", "home"]]; if (user?.role === "admin" || user?.chat_enabled) items.push(["chat", "چت", "chat"]); if (user?.role === "admin" || user?.api_enabled) items.push(["keys", "کلیدهای API", "key"]); items.push(["usage", "مصرف و Usage", "chart"], ["account", "حساب کاربری", "user"]); if (user?.role === "admin" || user?.mlops_enabled) items.push(["mlops", "MLOps", "chart"]); if (user?.role === "admin") items.push(["admin", "مدیریت کاربران", "user"]); if (user?.role === "admin") items.push(["admin_usage", "مصرف API کاربران", "chart"]); return items; }, [user]);
  const pageTitle = active === "dashboard" ? "داشبورد" : active === "chat" ? "گفتگو" : active === "keys" ? "کلیدهای API" : active === "usage" ? "مصرف و Usage" : active === "account" ? "حساب کاربری" : active === "admin" ? "مدیریت کاربران" : active === "admin_usage" ? "مصرف API کاربران" : "MLOps";
  if (loading) return <div className="boot"><div className="brand-mark">T</div><div>در حال راه‌اندازی پنل…</div></div>;
  if (!user) return <Auth mode={authMode} setMode={setAuthMode} submit={submitAuth} error={formError} />;
  if (forcePasswordChange) return <ChangePassword user={user} onChange={changePassword} onLogout={logout} error={formError} />;

  return <main className="app-shell">
    {toast && (
      <div className={`toast ${toast.type}`}>
        <span>{toast.message}</span>
        <button aria-label="بستن" onClick={() => setToast(null)}>×</button>
      </div>
    )}
    <aside className="sidebar"><div className="brand-lockup side-brand"><div className="brand-mark">T</div><div><b>TaHa</b><span>AI Platform</span></div></div><button className="new-chat" onClick={newConversation}><Icon name="plus"/>گفتگوی جدید</button><nav>{sidebar.map(([id, label, icon]) => <button key={id} className={active === id ? "nav-item active" : "nav-item"} onClick={async () => { if (id === "mlops") { try { await api("/mlops/access"); setActive("mlops"); } catch (err: any) { setFormError(err.message); } } else { setActive(id); } }}><Icon name={icon}/><span>{label}</span></button>)}</nav><div className="history-panel"><div className="history-head"><div className="history-title">گفتگوهای اخیر</div>{historyAvailable && <span>{conversations.length}</span>}</div>{historyAvailable ? conversations.slice(0, 8).map((c) => <div className={`history-item ${conversationId === c.id ? "selected" : ""}`} key={c.id}><button onClick={() => openConversation(c.id)}>{c.title || "گفتگوی بدون عنوان"}</button><button className="history-delete" aria-label="حذف گفتگو" onClick={() => deleteConversation(c.id)}>×</button></div>) : <small>تاریخچه در API فعلی در دسترس نیست.</small>}{historyAvailable && conversations.length === 0 && <small>هنوز گفتگویی ندارید.</small>}</div><div className="sidebar-bottom"><div className="mini-user"><div className="avatar">{user.name.slice(0,1)}</div><div><b>{user.name}</b><small>{user.email}</small></div></div><button className="logout" aria-label="خروج" onClick={logout}><Icon name="logout"/></button></div></aside>
    <section className="main-panel"><header className="topbar"><div><span className="crumb">پنل کاربری</span><h2>{pageTitle}</h2></div><div className="top-actions"><label className="theme-select-wrap"><span>استایل</span><select className="theme-select" value={theme} aria-label="انتخاب استایل پنل" onChange={(e) => setTheme(e.target.value as typeof theme)}><option value="dark">Graphite · تیره</option><option value="light">Light · روشن</option><option value="midnight">Midnight · شبانه</option><option value="ocean">Ocean · اقیانوسی</option><option value="glass">Glass · شیشه‌ای</option><option value="paper">Paper · کاغذی</option></select></label><div className="status"><i/> سرویس فعال</div></div></header>{formError && active !== "chat" && <div className="global-notice">{formError}<button onClick={() => setFormError("")}>×</button></div>}{active === "dashboard" && <Dashboard user={user} data={dashboard} keys={keys} onChat={newConversation} onKeys={() => setActive("keys")} />}{active === "chat" && <Chat selectedModel={selectedModel} setSelectedModel={setSelectedModel} models={models} messages={messages} input={input} setInput={setInput} sendChat={sendChat} sending={sending} onNew={newConversation} onStop={stopGeneration} editingIndex={editingIndex} cancelEdit={() => { setEditingIndex(null); setInput(""); }} onEdit={editMessage} onRegenerate={regenerate} historyAvailable={historyAvailable} attachments={attachments} setAttachments={setAttachments} onAddFiles={addFiles} formError={formError} setFormError={setFormError} />}{active === "keys" && <Keys keys={keys} models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} deleteKey={deleteKey} rotateKey={rotateKey} openModal={() => setKeyModal(true)} newKey={newKey} setNewKey={setNewKey} notify={notify} />}{active === "usage" && <Usage keys={keys} data={usage} />}{active === "account" && <Account user={user} theme={theme} setTheme={setTheme} onProfileUpdate={(nextUser: any) => setUser((current: any) => ({ ...current, ...nextUser }))} />}{active === "mlops" && <MLOps />}{active === "admin" && user.role === "admin" && <AdminUsers notify={notify} />}{active === "admin_usage" && user.role === "admin" && <AdminApiBudgets notify={notify} />} </section>
    {keyModal && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h3>ساخت کلید API</h3><button onClick={() => setKeyModal(false)}>×</button></div><form className="form-stack" onSubmit={createKey}><label>نام کلید<input name="alias" required placeholder="Production App" /></label><label>مدل<input value={selectedModel} readOnly /></label><label>محدودیت RPM<input name="rpm" type="number" defaultValue={30} min={1} /></label><label>انقضا<select name="duration" defaultValue="30d"><option value="30d">۳۰ روز</option><option value="90d">۹۰ روز</option><option value="365d">۱ سال</option><option value="">بدون انقضا</option></select></label>{formError && <div className="error-box">{formError}</div>}<button className="primary" type="submit">ایجاد کلید</button></form></div></div>}
  </main>;
}

function Auth({ mode, setMode, submit, error }: any) { return <main className="auth-shell"><section className="auth-card"><div className="brand-lockup"><div className="brand-mark large">T</div><div><b>TaHa</b><span>هوش مصنوعی حرفه‌ای</span></div></div><h1>{mode === "login" ? "خوش آمدید" : "ساخت حساب کاربری"}</h1><p className="muted">دسترسی به چت و سرویس‌های هوش مصنوعی TaHa</p><form onSubmit={submit} className="form-stack">{mode === "register" && <label>نام<input name="name" required placeholder="نام شما" /></label>}<label>ایمیل<input name="email" type="email" required placeholder="you@example.com" /></label><label>رمز عبور<input name="password" type="password" minLength={8} required placeholder="حداقل ۸ کاراکتر" /></label>{error && <div className="error-box">{error}</div>}<button className="primary full" type="submit">{mode === "login" ? "ورود" : "ثبت‌نام"}</button></form><button className="link-btn" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "حساب دارید؟ وارد شوید"}</button></section></main>; }

function ChangePassword({ user, onChange, onLogout, error }: any) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setLocalError("");
    const fd = new FormData(e.currentTarget);
    const currentPassword = String(fd.get("current_password") || "");
    const newPassword = String(fd.get("new_password") || "");
    const confirmPassword = String(fd.get("confirm_password") || "");
    if (newPassword !== confirmPassword) { setLocalError("تکرار رمز عبور یکسان نیست"); setBusy(false); return; }
    try { await onChange(currentPassword, newPassword); }
    catch (err: any) { setLocalError(err.message || "تغییر رمز عبور ناموفق بود"); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-card">
    <div className="brand-lockup"><div className="brand-mark large">T</div><div><b>TaHa</b><span>هوش مصنوعی حرفه‌ای</span></div></div>
    <h1>تغییر اجباری رمز عبور</h1>
    <p className="muted">برای ادامه استفاده از پنل، ابتدا رمز عبور حساب {user?.email} را تغییر دهید.</p>
    <form onSubmit={submit} className="form-stack">
      <label>رمز عبور فعلی<input name="current_password" type="password" required /></label>
      <label>رمز عبور جدید<input name="new_password" type="password" minLength={8} required placeholder="حداقل ۸ کاراکتر" /></label>
      <label>تکرار رمز عبور جدید<input name="confirm_password" type="password" minLength={8} required /></label>
      {(localError || error) && <div className="error-box">{localError || error}</div>}
      <button className="primary full" type="submit" disabled={busy}>{busy ? "در حال تغییر…" : "تغییر رمز عبور"}</button>
    </form>
    <button className="link-btn" onClick={onLogout}>خروج</button>
  </section></main>;
}


function AdminApiBudgets({ notify }: any) {
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [keys, setKeys] = useState<any[]>([]);
  const [draft, setDraft] = useState<Record<string, { max_budget: string; budget_duration: string }>>({});
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  const unwrapRows = (value: any, keys: string[]) => {
    if (Array.isArray(value)) return value;
    for (const k of keys) if (Array.isArray(value?.[k])) return value[k];
    return [];
  };

  const loadUsers = async () => {
    setLoadingUsers(true); setError("");
    try {
      const result = await api("/admin/users");
      const rows = unwrapRows(result, ["data", "users"]);
      setUsers(rows);
      if (!selectedUser && rows[0]?.id) setSelectedUser(rows[0].id);
      else if (selectedUser && !rows.some((u: any) => u.id === selectedUser)) setSelectedUser(rows[0]?.id || "");
    } catch (err: any) {
      setError(err?.message || "خطا در دریافت کاربران");
    } finally { setLoadingUsers(false); }
  };

  const loadKeys = async (userId: string) => {
    if (!userId) { setKeys([]); return; }
    setLoadingKeys(true); setError("");
    try {
      const result = await api(`/admin/users/${userId}/api-keys`);
      const rows = unwrapRows(result, ["data", "keys"]);
      setKeys(rows);
      setDraft((old) => {
        const next = { ...old };
        for (const k of rows) {
          next[k.id] = {
            max_budget: k.max_budget != null ? String(k.max_budget) : "",
            budget_duration: k.budget_duration || "30d",
          };
        }
        return next;
      });
    } catch (err: any) {
      setError(err?.message || "خطا در دریافت کلیدهای API"); setKeys([]);
    } finally { setLoadingKeys(false); }
  };

  useEffect(() => { loadUsers(); }, []);
  useEffect(() => { loadKeys(selectedUser); }, [selectedUser]);

  const save = async (key: any) => {
    const d = draft[key.id] || { max_budget: "", budget_duration: "30d" };
    const amount = Number(d.max_budget);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("سقف مصرف باید بیشتر از صفر باشد");
      return;
    }
    setSaving(key.id); setError("");
    try {
      const result = await api(`/admin/api-keys/${key.id}/budget`, {
        method: "POST",
        body: JSON.stringify({ max_budget: amount, budget_duration: d.budget_duration || "30d" }),
      });
      const updated = result?.data ?? result;
      setKeys((rows) => rows.map((row) => row.id === key.id ? { ...row, ...updated } : row));
      notify?.("سقف مصرف API با موفقیت ذخیره شد");
    } catch (err: any) {
      setError(err?.message || "ذخیره سقف مصرف ناموفق بود");
    } finally { setSaving(null); }
  };

  const selected = users.find((u: any) => u.id === selectedUser);

  return <div className="content admin-api-budgets">
    <div className="page-intro">
      <div><div className="eyebrow">API GOVERNANCE</div><h1>مدیریت مصرف API کاربران</h1><p>سقف مصرف و دوره بودجه هر API Key را از اینجا تعیین کنید. اعداد مصرف از LiteLLM خوانده می‌شوند.</p></div>
      <button type="button" className="secondary" onClick={() => { loadUsers(); loadKeys(selectedUser); }}>بازخوانی</button>
    </div>

    {error && <div className="error-box">{error}</div>}

    <div className="panel admin-budget-panel">
      <div className="admin-budget-toolbar">
        <label>کاربر
          <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} disabled={loadingUsers}>
            <option value="">انتخاب کاربر</option>
            {users.map((u: any) => <option key={u.id} value={u.id}>{u.name} — {u.email}</option>)}
          </select>
        </label>
        {selected && <div className="admin-budget-user-summary"><b>{selected.name}</b><span>{selected.email}</span></div>}
      </div>

      {loadingUsers || loadingKeys ? <div className="empty-card">در حال دریافت اطلاعات…</div> : !selectedUser ? <div className="empty-card">کاربری برای مدیریت انتخاب نشده است.</div> : keys.length === 0 ? <div className="empty-card"><h3>کلید API ندارد</h3><p>برای این کاربر هنوز API Key فعالی ثبت نشده است.</p></div> : <div className="admin-budget-table-wrap">
        <div className="admin-budget-table-head"><span>کلید</span><span>مصرف فعلی</span><span>سقف</span><span>دوره</span><span></span></div>
        {keys.map((k: any) => {
          const d = draft[k.id] || { max_budget: k.max_budget != null ? String(k.max_budget) : "", budget_duration: k.budget_duration || "30d" };
          return <div className="admin-budget-row" key={k.id}>
            <div><b>{k.alias}</b><small>{k.masked}</small></div>
            <div className="admin-budget-spend">${Number(k.spend || 0).toFixed(4)}{k.max_budget != null ? ` / $${Number(k.max_budget).toFixed(2)}` : " / بدون سقف"}</div>
            <input aria-label={`سقف مصرف ${k.alias}`} type="number" min="0.01" step="0.01" value={d.max_budget} onChange={(e) => setDraft((v) => ({ ...v, [k.id]: { ...d, max_budget: e.target.value } }))} />
            <select aria-label={`دوره بودجه ${k.alias}`} value={d.budget_duration} onChange={(e) => setDraft((v) => ({ ...v, [k.id]: { ...d, budget_duration: e.target.value } }))}>
              <option value="1d">روزانه</option><option value="7d">هفتگی</option><option value="30d">ماهانه</option>
            </select>
            <button type="button" className="primary" onClick={() => save(k)} disabled={saving === k.id}>{saving === k.id ? "در حال ذخیره…" : "ذخیره"}</button>
          </div>;
        })}
      </div>}
    </div>
  </div>;
}

function AdminUsers({ notify }: any) {
  const [users, setUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadUsers = async () => {
    setBusy(true); setError("");
    try { const result = await api("/admin/users"); setUsers(result.data || []); }
    catch (err: any) { setError(err.message || "خطا در دریافت کاربران"); }
    finally { setBusy(false); }
  };
  useEffect(() => { loadUsers(); }, []);

  const updateUser = async (id: string, patch: any) => {
    try {
      await api(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadUsers(); notify("اطلاعات کاربر به‌روزرسانی شد");
    } catch (err: any) { setError(err.message || "خطا در به‌روزرسانی کاربر"); }
  };

  const createUser = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setError("");
    const fd = new FormData(e.currentTarget);
    try {
      await api("/admin/users", { method: "POST", body: JSON.stringify({
        name: fd.get("name"), email: fd.get("email"), password: fd.get("password"),
        chat_enabled: fd.get("chat_enabled") === "on", api_enabled: fd.get("api_enabled") === "on", mlops_enabled: fd.get("mlops_enabled") === "on",
      }) });
      setShowCreate(false); await loadUsers(); notify("کاربر ایجاد شد و باید در اولین ورود رمز خود را تغییر دهد");
    } catch (err: any) { setError(err.message || "خطا در ایجاد کاربر"); }
  };

  const [userKeys, setUserKeys] = useState<Record<string, any[]>>({});
  const [loadingKeys, setLoadingKeys] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, {max_budget: string; budget_duration: string}>>({});
  const loadUserKeys = async (id: string) => {
    setLoadingKeys(id); setError("");
    try { const result = await api(`/admin/users/${id}/api-keys`); const items = result.data || []; setUserKeys((v) => ({...v, [id]: items})); const next = {...budgetDraft}; items.forEach((k: any) => { next[k.id] = { max_budget: k.max_budget != null ? String(k.max_budget) : "", budget_duration: k.budget_duration || "30d" }; }); setBudgetDraft(next); }
    catch (err: any) { setError(err.message || "خطا در دریافت کلیدها"); }
    finally { setLoadingKeys(null); }
  };
  const saveBudget = async (key: any) => {
    const draft = budgetDraft[key.id];
    const amount = Number(draft?.max_budget);
    if (!Number.isFinite(amount) || amount <= 0) { setError("سقف مصرف باید بیشتر از صفر باشد"); return; }
    try { const result = await api(`/admin/api-keys/${key.id}/budget`, { method: "POST", body: JSON.stringify({ max_budget: amount, budget_duration: draft.budget_duration || "30d" }) }); setUserKeys((v) => ({...v, [key._userId]: (v[key._userId] || []).map((x: any) => x.id === key.id ? result.data : x)})); notify("سقف مصرف کلید به‌روزرسانی شد"); await loadUserKeys(key._userId); }
    catch (err: any) { setError(err.message || "خطا در تنظیم سقف مصرف"); }
  };
  const statusLabel: Record<string,string> = { pending: "در انتظار", active: "فعال", disabled: "غیرفعال", rejected: "رد شده" };
  return <div className="content">
    <div className="page-intro"><div><div className="eyebrow">ADMIN CENTER</div><h1>مدیریت کاربران</h1><p>تأیید ثبت‌نام، تغییر وضعیت، نقش و سه دسترسی مستقل سرویس‌ها.</p></div><button className="primary" onClick={() => setShowCreate(true)}><Icon name="plus"/>ساخت کاربر</button></div>
    {error && <div className="global-notice">{error}<button onClick={() => setError("")}>×</button></div>}
    <div className="admin-table" style={{display:"grid",gap:12}}>
      {users.map((u) => <div key={u.id} className="dashboard-card" style={{padding:18}}>
        <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",flexWrap:"wrap"}}>
          <div><strong>{u.name}</strong><div className="muted">{u.email}</div></div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <select value={u.status} onChange={(e) => updateUser(u.id,{status:e.target.value})}>{Object.entries(statusLabel).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
            <select value={u.role} onChange={(e) => updateUser(u.id,{role:e.target.value})}><option value="user">کاربر</option><option value="admin">مدیر</option></select>
          </div>
        </div>
        <div style={{display:"flex",gap:18,flexWrap:"wrap",marginTop:14}}>
          <label><input type="checkbox" checked={u.chat_enabled} onChange={(e) => updateUser(u.id,{chat_enabled:e.target.checked})}/> Chat</label>
          <label><input type="checkbox" checked={u.api_enabled} onChange={(e) => updateUser(u.id,{api_enabled:e.target.checked})}/> API Key</label>
          <label><input type="checkbox" checked={u.mlops_enabled} onChange={(e) => updateUser(u.id,{mlops_enabled:e.target.checked})}/> MLOps</label>
          {u.must_change_password && <span className="pill">نیازمند تغییر رمز</span>}
        </div>
        {u.status === "pending" && <div style={{display:"flex",gap:8,marginTop:14}}><button className="primary" onClick={() => updateUser(u.id,{status:"active"})}>تأیید</button><button className="danger" onClick={() => updateUser(u.id,{status:"rejected"})}>رد</button></div>}
      </div>)}
      {!busy && users.length === 0 && <div className="empty-card">کاربری ثبت نشده است.</div>}
      {busy && <div className="empty-card">در حال دریافت کاربران…</div>}
    </div>
    {showCreate && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h3>ساخت کاربر جدید</h3><button onClick={() => setShowCreate(false)}>×</button></div><form className="form-stack" onSubmit={createUser}>
      <label>نام<input name="name" required minLength={2}/></label><label>ایمیل<input name="email" type="email" required/></label><label>رمز موقت<input name="password" type="password" minLength={8} required/></label>
      <label><input name="chat_enabled" type="checkbox" defaultChecked/> Chat</label><label><input name="api_enabled" type="checkbox" defaultChecked/> API Key</label><label><input name="mlops_enabled" type="checkbox"/> MLOps</label>
      {error && <div className="error-box">{error}</div>}<button className="primary" type="submit">ایجاد کاربر</button>
    </form></div></div>}
  </div>;
}

function Dashboard({ user, data, keys, onChat, onKeys }: any) {
  const safeKeys: Key[] = Array.isArray(keys) ? keys : [];
  const activeKeys = safeKeys.filter((k) => k.status === "active").length;
  const totalKeys = safeKeys.length;
  const totalSpend = Number(data?.spend || 0);
  const messageCount = Number(data?.messages || 0);

  const models =
    Array.isArray(data?.models) && data.models.length
      ? data.models
      : ["TaHa1_VL"];

  const activeRatio = totalKeys
    ? Math.round((activeKeys / totalKeys) * 100)
    : 0;

  const spendRows = [...safeKeys]
    .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
    .slice(0, 6);

  const maxSpend = Math.max(
    ...spendRows.map((k) => Number(k.spend || 0)),
    0.000001
  );

  return (
    <div className="content dashboard-page modern-dashboard">

      <div className="modern-dashboard-hero">
        <div>
          <div className="eyebrow">TAHA AI PLATFORM</div>
          <h1>سلام {user.name} 👋</h1>
          <p>مرکز کنترل سرویس هوش مصنوعی و API شما</p>
        </div>

        <button className="primary modern-dashboard-action" onClick={onChat}>
          <Icon name="chat" />
          شروع گفتگو
        </button>
      </div>

      <div className="modern-stat-grid">

        <div className="modern-stat">
          <div className="modern-stat-icon">
            <Icon name="chat" />
          </div>
          <div className="modern-stat-body">
            <span>مدل فعال</span>
            <strong>{models[0]}</strong>
            <small>Text · Vision · Video</small>
          </div>
          <i className="modern-online-dot" />
        </div>

        <div className="modern-stat">
          <div className="modern-stat-icon">
            <Icon name="key" />
          </div>
          <div className="modern-stat-body">
            <span>API Keys</span>
            <strong>{activeKeys} <em>/ {totalKeys}</em></strong>
            <small>{activeRatio}% فعال</small>
          </div>
          <div className="modern-mini-bar">
            <i style={{ width: `${activeRatio}%` }} />
          </div>
        </div>

        <div className="modern-stat">
          <div className="modern-stat-icon">
            <Icon name="chart" />
          </div>
          <div className="modern-stat-body">
            <span>مصرف کل</span>
            <strong>${totalSpend.toFixed(4)}</strong>
            <small>{messageCount ? `${messageCount} پیام` : "مصرف فعلی سرویس"}</small>
          </div>
        </div>

      </div>

      <div className="modern-dashboard-grid">

        <section className="modern-panel health-panel">
          <div className="modern-panel-head">
            <div>
              <span className="eyebrow">SYSTEM HEALTH</span>
              <h3>وضعیت سرویس</h3>
            </div>

            <span className="modern-online-badge">
              <i />
              ONLINE
            </span>
          </div>

          <div className="health-content">

            <div
              className="health-circle"
              style={{
                background: `conic-gradient(var(--accent) ${activeRatio}%, color-mix(in srgb, var(--line) 60%, transparent) 0)`
              }}
            >
              <div className="health-circle-inner">
                <strong>{activeRatio}%</strong>
                <span>API READY</span>
              </div>
            </div>

            <div className="health-list">

              <div className="health-row">
                <span className="health-status-dot" />
                <div>
                  <b>LiteLLM Gateway</b>
                  <small>API Gateway</small>
                </div>
                <strong>OK</strong>
              </div>

              <div className="health-row">
                <span className="health-status-dot" />
                <div>
                  <b>TaHa1_VL</b>
                  <small>30B · Vision Language</small>
                </div>
                <strong>READY</strong>
              </div>

              <div className="health-row">
                <span className="health-status-dot" />
                <div>
                  <b>Multimodal</b>
                  <small>Image · Video · PDF</small>
                </div>
                <strong>ONLINE</strong>
              </div>

            </div>
          </div>
        </section>

        <section className="modern-panel usage-panel">

          <div className="modern-panel-head">
            <div>
              <span className="eyebrow">API USAGE</span>
              <h3>مصرف کلیدها</h3>
            </div>

            <button className="modern-text-button" onClick={onKeys}>
              مدیریت
            </button>
          </div>

          {spendRows.length === 0 ? (
            <div className="modern-empty-chart">
              <div>
                <Icon name="chart" />
              </div>
              <b>هنوز مصرفی ثبت نشده</b>
              <span>پس از استفاده از API، نمودار اینجا نمایش داده می‌شود.</span>
            </div>
          ) : (
            <div className="modern-chart">
              {spendRows.map((k) => {
                const value = Number(k.spend || 0);
                const width = Math.max(
                  5,
                  Math.round((value / maxSpend) * 100)
                );

                return (
                  <div className="modern-chart-row" key={k.id}>
                    <div className="modern-chart-name">
                      <b>{k.alias}</b>
                      <span>{k.masked}</span>
                    </div>

                    <div className="modern-chart-track">
                      <i style={{ width: `${width}%` }} />
                    </div>

                    <strong>${value.toFixed(4)}</strong>
                  </div>
                );
              })}
            </div>
          )}

        </section>

      </div>

      <div className="modern-bottom-grid">

        <section className="modern-panel model-panel">

          <div className="modern-panel-head">
            <div>
              <span className="eyebrow">ACTIVE MODEL</span>
              <h3>مدل هوش مصنوعی</h3>
            </div>

            <span className="modern-ready">READY</span>
          </div>

          <div className="model-stage">
            <div className="model-orbit orbit-a" />
            <div className="model-orbit orbit-b" />
            <div className="model-orbit-dot dot-a" />
            <div className="model-orbit-dot dot-b" />
            <div className="model-core">VL</div>
          </div>

          <div className="model-caption">
            <b>{getModelDisplayName(models[0])}</b>
            <span>متن · تصویر · ویدئو · PDF</span>
          </div>

        </section>

        <section className="modern-panel actions-panel">

          <div className="modern-panel-head">
            <div>
              <span className="eyebrow">QUICK ACTIONS</span>
              <h3>دسترسی سریع</h3>
            </div>
          </div>

          <div className="modern-actions">

            <button onClick={onChat}>
              <div className="modern-action-icon">
                <Icon name="chat" />
              </div>
              <div>
                <b>گفتگوی جدید</b>
                <span>شروع مکالمه با مدل</span>
              </div>
            </button>

            <button onClick={onKeys}>
              <div className="modern-action-icon">
                <Icon name="key" />
              </div>
              <div>
                <b>API Keys</b>
                <span>مدیریت کلیدهای دسترسی</span>
              </div>
            </button>

          </div>
        </section>

      </div>

    </div>
  );
}

function Stat({ title, value }: { title: string; value: string | number }) { return <div className="stat"><small>{title}</small><strong>{value}</strong><span>وضعیت فعلی</span></div>; }
function Chat({
  selectedModel,
  setSelectedModel,
  models,
  messages,
  input,
  setInput,
  sendChat,
  sending,
  onNew,
  onStop,
  editingIndex,
  cancelEdit,
  onEdit,
  onRegenerate,
  historyAvailable,
  attachments,
  setAttachments,
  onAddFiles,
  formError,
  setFormError
}: any) {
  const end = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-view">
      <div className="chat-head">
        <div>
          <h3>{messages.length ? "گفتگو" : "گفتگوی جدید"}</h3>
          <span>
            {historyAvailable
              ? "گفتگو و تاریخچه شما در پنل ذخیره می‌شود."
              : "پاسخ‌ها توسط مدل انتخاب‌شده تولید می‌شوند."}
          </span>
        </div>

        <div className="chat-tools">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            {models.map((m: Model) => (
              <option key={m.id} value={m.id}>{getModelDisplayName(m.id)}</option>
            ))}
          </select>

          <button className="secondary" onClick={onNew}>
            گفتگوی جدید
          </button>
        </div>
      </div>

      {editingIndex !== null && (
        <div className="edit-banner">
          در حال ویرایش پیام
          <button onClick={cancelEdit}>لغو</button>
        </div>
      )}

      {formError && (
        <div className="global-notice chat-error-notice">
          {formError}
          <button
            type="button"
            onClick={() => setFormError("")}
            aria-label="بستن پیام خطا"
          >
            ×
          </button>
        </div>
      )}

      <div className="messages">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <div className="brand-mark large">T</div>
            <h2>چطور می‌توانم کمک کنم؟</h2>
            <p>سؤال خود را بنویسید یا فایل و تصویر خود را پیوست کنید.</p>

            <div className="suggestions">
              <button onClick={() => setInput("یک متن حرفه‌ای برای معرفی محصول بنویس")}>
                معرفی محصول
              </button>
              <button onClick={() => setInput("این کد را بررسی و بهینه کن")}>
                بررسی کد
              </button>
              <button onClick={() => setInput("یک برنامه کاری هفتگی پیشنهاد بده")}>
                برنامه‌ریزی
              </button>
            </div>
          </div>
        ) : (
          messages.map((m: Msg, i: number) => (
            <div
              key={m.id || i}
              className={`message ${m.role}`}
            >
              <div className="bubble-wrap">
                <div className="bubble">
                  {m.role === "assistant" ? (
                    <Markdown
                      text={
                        m.content ||
                        (sending && i === messages.length - 1
                          ? "در حال تولید پاسخ…"
                          : "")
                      }
                    />
                  ) : (
                    <>
                      {m.attachments?.length > 0 && (
                        <div className="message-attachments">
                          {m.attachments.map((a) => (
                            <span
                              className="attachment-chip"
                              key={`${a.name}-${a.mime}`}
                              title={a.mime}
                            >
                              📎 {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {m.content}
                    </>
                  )}
                </div>

                <div className="message-actions">
                  {m.role === "user" && (
                    <button onClick={() => onEdit(i)} disabled={sending}>
                      <Icon name="edit"/>ویرایش
                    </button>
                  )}

                  {m.role === "assistant" && (
                    <button onClick={() => onRegenerate(i)} disabled={sending}>
                      <Icon name="refresh"/>پاسخ دوباره
                    </button>
                  )}

                  {m.content && (
                    <button onClick={() => navigator.clipboard?.writeText(m.content)}>
                      <Icon name="copy"/>کپی
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

        <div ref={end}/>
      </div>

      {formError && (
        <div className="global-notice attachment-error" role="alert">
          <span>{formError}</span>
          <button
            type="button"
            onClick={() => setFormError("")}
            aria-label="بستن خطا"
          >
            ×
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-list">
          {attachments.map((a: Attachment) => (
            <div className="attachment-item" key={a.id}>
              <span title={a.mime}>📎 {a.name}</span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((current: Attachment[]) =>
                    current.filter((x) => x.id !== a.id)
                  )
                }
                aria-label={`حذف ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={[
            "image/*",
            "video/*",
            "application/pdf",
            "text/*",
            ".txt",
            ".md",
            ".markdown",
            ".json",
            ".csv",
            ".tsv",
            ".log",
            ".py",
            ".js",
            ".jsx",
            ".ts",
            ".tsx",
            ".html",
            ".css",
            ".scss",
            ".xml",
            ".yaml",
            ".yml",
            ".ini",
            ".conf",
            ".sh",
            ".bash",
            ".sql",
            ".toml",
            ".env"
          ].join(",")}
          onChange={async (e) => {
            const files = e.target.files;

            if (files?.length && !sending) {
              setFormError("");

              try {
                await onAddFiles(files);
              } catch (err: any) {
                setFormError(
                  err?.message || "افزودن فایل ناموفق بود."
                );
              }
            }

            e.currentTarget.value = "";
          }}
        />

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!sending) sendChat();
            }
          }}
          placeholder="پیام خود را بنویسید یا فایل پیوست کنید…"
        />

        <div className="composer-actions">
          {!sending && (
            <button
              type="button"
              className="secondary attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="افزودن فایل"
              aria-label="افزودن فایل"
            >
              📎
            </button>
          )}

          {sending ? (
            <button className="stop-btn" onClick={onStop}>
              <Icon name="stop"/>توقف
            </button>
          ) : (
            <button
              className="send-btn-inline"
              onClick={sendChat}
              disabled={
                (!input.trim() && attachments.length === 0) ||
                !selectedModel
              }
            >
              <Icon name="send"/>
            </button>
          )}
        </div>

        <div className="composer-hint">
          Enter برای ارسال · Shift+Enter برای خط جدید · 📎 تصویر، ویدئو، PDF و فایل متنی
          {historyAvailable ? " · ذخیره خودکار تاریخچه" : ""}
        </div>
      </div>
    </div>
  );
}

function Keys({ keys, models, selectedModel, setSelectedModel, deleteKey, rotateKey, openModal, newKey, setNewKey, notify }: any) {
  return (
    <div className="content keys-page">
      <div className="page-intro keys-hero">
        <div>
          <div className="eyebrow">API CENTER</div>
          <h1>کلیدهای API</h1>
          <p>کلیدهای دسترسی خود را مدیریت کنید.</p>
        </div>
        <button className="primary" onClick={openModal}>
          <Icon name="plus"/> ساخت کلید جدید
        </button>
      </div>

      <div className="keys-toolbar">
        <div className="keys-toolbar-label">
          <span>مدل پیش‌فرض</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            aria-label="مدل پیش‌فرض برای کلید جدید"
          >
            {models.map((m: Model) => (
              <option key={m.id} value={m.id}>{getModelDisplayName(m.id)}</option>
            ))}
          </select>
        </div>
        <div className="keys-count">
          <Icon name="key"/>
          <span>{keys.length} کلید</span>
        </div>
      </div>

      {newKey && (
        <section className="key-reveal">
          <div className="key-reveal-main">
            <div className="key-reveal-badge">
              <Icon name="key"/>
            </div>
            <div>
              <strong>کلید جدید ایجاد شد</strong>
              <p>این مقدار فقط همین حالا قابل مشاهده است.</p>
            </div>
          </div>

          <code className="key-reveal-secret">{newKey.key}</code>

          <div className="key-reveal-actions">
            <button
              className="key-button"
              onClick={() =>
                navigator.clipboard?.writeText(newKey.key).then(() => notify("کلید API کپی شد"))
              }
            >
              <Icon name="copy"/> کپی
            </button>
            <button className="key-icon-button" onClick={() => setNewKey(null)} aria-label="بستن">
              ×
            </button>
          </div>
        </section>
      )}

      {keys.length > 0 ? (
        <div className="key-grid-modern">
          {keys.map((k: Key) => {
            const kk: any = k;
            const spend = Number(kk.spend || 0);
            const budget = kk.max_budget != null ? Number(kk.max_budget) : null;
            const remaining = budget != null ? Math.max(0, budget - spend) : null;
            const usagePercent = budget && budget > 0
              ? Math.min(100, Math.max(0, (spend / budget) * 100))
              : 0;
            const modelLabel = Array.isArray(kk.models) && kk.models.length
              ? kk.models.join("، ")
              : "—";

            return (
              <article
                className="key-card-modern"
                key={kk.id}
                data-status={kk.status}
              >
                <div className="key-card-header">
                  <div className="key-card-identity">
                    <div className="key-card-icon">
                      <Icon name="key"/>
                    </div>
                    <div className="key-card-title">
                      <strong>{kk.alias}</strong>
                      <span>{kk.masked}</span>
                    </div>
                  </div>

                  <span className={`key-status ${kk.status === "active" ? "active" : "revoked"}`}>
                    <i/>
                    {kk.status === "active" ? "فعال" : "لغو شده"}
                  </span>
                </div>

                <div className="key-secret-box">
                  <div>
                    <span>کلید</span>
                    <code>{kk.masked}</code>
                  </div>
                  <span className="key-secret-lock">•••</span>
                </div>

                <div className="key-metrics">
                  <div className="key-metric">
                    <span>مدل</span>
                    <strong title={modelLabel}>{modelLabel}</strong>
                  </div>
                  <div className="key-metric">
                    <span>RPM</span>
                    <strong>{kk.rpm_limit ?? "—"}</strong>
                  </div>
                  <div className="key-metric">
                    <span>مصرف</span>
                    <strong>${spend.toFixed(4)}</strong>
                  </div>
                </div>

                <div className="key-budget">
                  <div className="key-budget-head">
                    <span>بودجه</span>
                    {budget != null ? (
                      <strong>
                        ${remaining!.toFixed(2)} باقی‌مانده
                      </strong>
                    ) : (
                      <strong>بدون سقف</strong>
                    )}
                  </div>

                  {budget != null && (
                    <>
                      <div className="key-progress">
                        <i style={{ width: `${usagePercent}%` }}/>
                      </div>
                      <div className="key-budget-foot">
                        <span>مصرف ${spend.toFixed(2)}</span>
                        <span>سقف ${budget.toFixed(2)}</span>
                      </div>
                    </>
                  )}
                </div>

                <div className="key-card-footer">
                  <div className="key-details">
                    {kk.budget_duration && <span>{kk.budget_duration}</span>}
                    {kk.expires_at && (
                      <span>
                        انقضا: {new Date(kk.expires_at).toLocaleDateString("fa-IR")}
                      </span>
                    )}
                  </div>

                  <div className="key-actions-modern">
                    <button
                      className="key-button"
                      onClick={() => rotateKey(kk.id)}
                      disabled={kk.status !== "active"}
                    >
                      <Icon name="refresh"/> چرخش
                    </button>
                    <button
                      className="key-button danger"
                      onClick={() => deleteKey(kk.id)}
                      disabled={kk.status !== "active"}
                    >
                      <Icon name="trash"/> لغو
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="key-empty-modern">
          <div className="key-empty-icon">
            <Icon name="key"/>
          </div>
          <h3>هنوز کلیدی ندارید</h3>
          <p>اولین API Key خود را ایجاد کنید.</p>
          <button className="primary" onClick={openModal}>
            <Icon name="plus"/> ساخت اولین کلید
          </button>
        </div>
      )}
    </div>
  );
}

function Usage({ keys, data }: any) {
  const rows = Array.isArray(data?.keys) ? data.keys : keys;
  const activeKeys = keys.filter((k: Key) => k.status === "active").length;
  const totalSpend = Number(data?.total_spend ?? data?.spend ?? 0);
  const messageCount = Number(data?.messages ?? 0);

  const maxSpend = Math.max(
    ...rows.map((k: any) => Number(k.spend || 0)),
    0.000001
  );

  return (
    <div className="content usage-page">
      <div className="page-intro usage-intro">
        <div>
          <div className="eyebrow">USAGE CENTER</div>
          <h1>مصرف و Usage</h1>
          <p>نمای دقیق وضعیت مصرف سرویس‌های TaHa بر اساس داده‌های واقعی حساب شما.</p>
        </div>
      </div>

      <div className="dashboard-stats">
        <div className="dashboard-stat">
          <div className="dashboard-stat-icon"><Icon name="key" /></div>
          <div>
            <span>کلیدهای فعال</span>
            <strong>{activeKeys}</strong>
            <small>از {keys.length} کلید ثبت‌شده</small>
          </div>
        </div>

        <div className="dashboard-stat">
          <div className="dashboard-stat-icon"><Icon name="chart" /></div>
          <div>
            <span>هزینه ثبت‌شده</span>
            <strong>${totalSpend.toFixed(4)}</strong>
            <small>مجموع مصرف گزارش‌شده</small>
          </div>
        </div>

        <div className="dashboard-stat">
          <div className="dashboard-stat-icon"><Icon name="chat" /></div>
          <div>
            <span>پیام‌ها</span>
            <strong>{messageCount}</strong>
            <small>پیام ذخیره‌شده در Portal</small>
          </div>
        </div>
      </div>

      <section className="dashboard-card usage-card">
        <div className="dashboard-card-head">
          <div>
            <span className="eyebrow">API KEYS</span>
            <h3>مصرف به تفکیک کلید</h3>
          </div>
          <span className="usage-total">${totalSpend.toFixed(4)}</span>
        </div>

        {rows.length === 0 ? (
          <div className="usage-empty">
            <div className="dashboard-stat-icon"><Icon name="chart" /></div>
            <h3>هنوز داده‌ای برای مصرف وجود ندارد</h3>
            <p>پس از استفاده از API، مصرف هر کلید در این بخش نمایش داده می‌شود.</p>
          </div>
        ) : (
          <div className="usage-list">
            {rows.map((k: any) => {
              const spend = Number(k.spend || 0);
              const budget = k.max_budget != null ? Number(k.max_budget) : null;
              const width = budget && budget > 0 ? Math.min(100, (spend / budget) * 100) : Math.max(2, (spend / maxSpend) * 100);

              return (
                <div className="usage-item" key={k.id}>
                  <div className="usage-item-top">
                    <div>
                      <b>{k.alias}</b>
                      <span className={`usage-status ${k.status}`}>
                        {k.status === "active" ? "فعال" : "لغو شده"}
                      </span>
                    </div>
                    <strong>${spend.toFixed(4)}</strong>
                  </div>

                  <div className="usage-track">
                    <i style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}


function MLOps() {
  const fallbackVideos = [
    { id: 1, title: "آموزش MLOps — جلسه ۱", file: "01.mp4" },
    { id: 2, title: "آموزش MLOps — جلسه ۲", file: "02.mp4" },
    { id: 3, title: "آموزش MLOps — جلسه ۳", file: "03.mp4" },
    { id: 4, title: "آموزش MLOps — جلسه ۴", file: "04.mp4" },
    { id: 5, title: "آموزش MLOps — جلسه ۵", file: "05.mp4" },
    { id: 6, title: "آموزش MLOps — جلسه ۶", file: "06.mp4" },
    { id: 7, title: "آموزش MLOps — جلسه ۷", file: "07.mp4" },
    { id: 8, title: "آموزش MLOps — جلسه ۸", file: "08.mp4" },
    { id: 9, title: "آموزش MLOps — جلسه ۹", file: "09.mp4" },
    { id: 10, title: "آموزش MLOps — جلسه ۱۰", file: "10.mp4" },
    { id: 11, title: "آموزش MLOps — جلسه ۱۱", file: "11.mp4" },
  ];

  const [section, setSection] = useState<"videos" | "clearml">("videos");
  const [videos, setVideos] = useState(fallbackVideos);
  const [selected, setSelected] = useState(0);
  const [clearmlUrl, setClearmlUrl] = useState("https://app.hinaa.ir");
  const [clearmlBusy, setClearmlBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    fetch("/mlops-videos/videos.json", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("manifest unavailable");
        return res.json();
      })
      .then((data) => {
        if (!mounted || !Array.isArray(data) || data.length === 0) return;
        const valid = data.filter(
          (v: any) =>
            v &&
            typeof v.file === "string" &&
            v.file.trim() &&
            typeof v.title === "string" &&
            v.title.trim()
        );
        if (valid.length > 0) {
          setVideos(valid);
          setSelected(0);
        }
      })
      .catch(() => {
        // Fallback list remains available.
      });

    return () => {
      mounted = false;
    };
  }, []);

  const current = videos[selected] || videos[0];

  const openClearML = async () => {
    setClearmlBusy(true);
    setError("");

    try {
      const gate = await api("/mlops/access");
      if (gate?.url) setClearmlUrl(gate.url);
      window.open(gate?.url || "https://app.hinaa.ir", "_blank", "noopener,noreferrer");
    } catch (err: any) {
      setError(err.message || "دسترسی به ClearML امکان‌پذیر نیست");
    } finally {
      setClearmlBusy(false);
    }
  };

  return (
    <div className="content mlops-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">MLOPS</div>
          <h1>مدیریت و آموزش MLOps</h1>
          <p>آموزش‌های ویدئویی و دسترسی به پنل ClearML در یک بخش یکپارچه.</p>
        </div>
      </div>

      {error && (
        <div className="global-notice">
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      <div className="mlops-tabs">
        <button
          type="button"
          className={`mlops-tab ${section === "videos" ? "active" : ""}`}
          onClick={() => setSection("videos")}
        >
          <span className="mlops-tab-icon">▶</span>
          <span>
            <b>فیلم‌های آموزشی</b>
            <small>{videos.length} آموزش</small>
          </span>
        </button>

        <button
          type="button"
          className={`mlops-tab ${section === "clearml" ? "active" : ""}`}
          onClick={() => setSection("clearml")}
        >
          <span className="mlops-tab-icon">⚙</span>
          <span>
            <b>پنل ClearML</b>
            <small>مدیریت پروژه‌های MLOps</small>
          </span>
        </button>
      </div>

      {section === "videos" && (
        <div className="mlops-video-layout">
          <section className="info-card mlops-player-card">
            {current ? (
              <>
                <div className="mlops-player-head">
                  <div>
                    <span className="eyebrow">TRAINING VIDEO</span>
                    <h3>{current.title}</h3>
                  </div>

                  <a
                    className="secondary mlops-download"
                    href={`/mlops-video/${encodeURIComponent(current.file)}?download=1`}
                    download
                  >
                    دانلود ویدئو
                  </a>
                </div>

                <div className="mlops-player">
                  <video
                    key={current.file}
                    controls
                    preload="metadata"
                    playsInline
                    src={`/mlops-video/${encodeURIComponent(current.file)}`}
                  >
                    مرورگر شما از پخش ویدئو پشتیبانی نمی‌کند.
                  </video>
                </div>

                <div className="mlops-player-foot">
                  <span>درس {String(current.id).padStart(2, "0")}</span>
                  <span>پخش مستقیم از سرور TaHa</span>
                </div>
              </>
            ) : (
              <div className="empty-card">ویدئویی برای نمایش وجود ندارد.</div>
            )}
          </section>

          <aside className="info-card mlops-video-list">
            <div className="mlops-list-head">
              <div>
                <span className="eyebrow">LESSONS</span>
                <h3>فهرست فیلم‌ها</h3>
              </div>
              <span className="pill">{videos.length}</span>
            </div>

            <div className="mlops-video-items">
              {videos.map((video: any, index: number) => (
                <button
                  key={`${video.file}-${index}`}
                  type="button"
                  className={`mlops-video-item ${selected === index ? "selected" : ""}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="mlops-video-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="mlops-video-title">{video.title}</span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {section === "clearml" && (
        <section className="info-card mlops-clearml-card">
          <div className="mlops-clearml-mark">C</div>

          <div className="mlops-clearml-body">
            <span className="eyebrow">CLEARML PLATFORM</span>
            <h2>پنل ClearML</h2>
            <p>
              محیط مدیریت پروژه‌ها، Experimentها، Taskها، مدل‌ها و سرویس‌های
              MLOps از همین بخش در دسترس است.
            </p>

            <div className="mlops-clearml-meta">
              <div>
                <span>سرویس</span>
                <b>ClearML</b>
              </div>

              <div>
                <span>نشانی</span>
                <b>{clearmlUrl}</b>
              </div>

              <div>
                <span>وضعیت</span>
                <b>محافظت‌شده</b>
              </div>
            </div>

            <button
              type="button"
              className="primary mlops-clearml-button"
              onClick={openClearML}
              disabled={clearmlBusy}
            >
              {clearmlBusy ? "در حال بررسی دسترسی…" : "ورود به پنل ClearML"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Account({ user, theme, setTheme, onProfileUpdate }: any) {
  const [name, setName] = useState(String(user?.name || ""));
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountSuccess, setAccountSuccess] = useState("");

  const avatarLetter = (name.trim() || user?.email || "T").charAt(0).toUpperCase();

  const saveProfile = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAccountError("");
    setAccountSuccess("");

    const cleanName = name.trim();

    if (cleanName.length < 2) {
      setAccountError("نام باید حداقل ۲ کاراکتر باشد");
      return;
    }

    setProfileBusy(true);

    try {
      const result = await api("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: cleanName }),
      });

      setName(cleanName);

      if (result?.user) {
        onProfileUpdate?.(result.user);
      } else {
        onProfileUpdate?.({ name: cleanName });
      }

      setAccountSuccess("اطلاعات پروفایل با موفقیت ذخیره شد");
    } catch (err: any) {
      setAccountError(err.message || "ذخیره پروفایل ناموفق بود");
    } finally {
      setProfileBusy(false);
    }
  };

  const savePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAccountError("");
    setAccountSuccess("");

    if (!currentPassword || !newPassword || !confirmPassword) {
      setAccountError("همه فیلدهای رمز عبور را تکمیل کنید");
      return;
    }

    if (newPassword.length < 8) {
      setAccountError("رمز عبور جدید باید حداقل ۸ کاراکتر باشد");
      return;
    }

    if (newPassword !== confirmPassword) {
      setAccountError("تکرار رمز عبور یکسان نیست");
      return;
    }

    setPasswordBusy(true);

    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setAccountSuccess("رمز عبور با موفقیت تغییر کرد");
    } catch (err: any) {
      setAccountError(err.message || "تغییر رمز عبور ناموفق بود");
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="content account-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">ACCOUNT</div>
          <h1>حساب کاربری</h1>
          <p>اطلاعات حساب، امنیت و ترجیحات پنل TaHa را مدیریت کنید.</p>
        </div>
      </div>

      {(accountError || accountSuccess) && (
        <div className={`account-message ${accountError ? "error" : "success"}`}>
          {accountError || accountSuccess}
        </div>
      )}

      <div className="account-grid">

        <section className="profile-card account-card account-profile-edit">
          <div className="account-card-title">
            <div className="avatar huge">{avatarLetter}</div>
            <div>
              <span className="eyebrow">PROFILE</span>
              <h3>پروفایل کاربری</h3>
              <p>اطلاعات نمایشی حساب خود را ویرایش کنید.</p>
            </div>
          </div>

          <form className="account-form" onSubmit={saveProfile}>
            <label>
              نام
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={120}
                autoComplete="name"
                required
              />
            </label>

            <label>
              ایمیل
              <input
                value={user?.email || ""}
                type="email"
                readOnly
              />
            </label>

            <div className="account-meta-grid">
              <div>
                <span>نقش</span>
                <b>{user?.role === "admin" ? "مدیر" : "کاربر"}</b>
              </div>

              <div>
                <span>وضعیت</span>
                <b>{user?.status === "active" ? "فعال" : (user?.status || "—")}</b>
              </div>
            </div>

            <button
              className="primary"
              type="submit"
              disabled={profileBusy}
            >
              {profileBusy ? "در حال ذخیره…" : "ذخیره تغییرات پروفایل"}
            </button>
          </form>
        </section>

        <section className="info-card account-card account-security-card">
          <div className="account-card-title">
            <div>
              <div className="eyebrow">SECURITY</div>
              <h3>امنیت حساب</h3>
              <p>رمز عبور حساب خود را تغییر دهید.</p>
            </div>
          </div>

          <form className="account-form" onSubmit={savePassword}>
            <label>
              رمز عبور فعلی
              <input
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </label>

            <label>
              رمز عبور جدید
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                type="password"
                minLength={8}
                autoComplete="new-password"
                placeholder="حداقل ۸ کاراکتر"
                required
              />
            </label>

            <label>
              تکرار رمز عبور جدید
              <input
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>

            <button
              className="primary"
              type="submit"
              disabled={passwordBusy}
            >
              {passwordBusy ? "در حال تغییر…" : "تغییر رمز عبور"}
            </button>
          </form>
        </section>

        <section className="info-card account-card account-appearance-card">
          <div>
            <span className="eyebrow">APPEARANCE</span>
            <h3>استایل پنل</h3>
            <p>یکی از پوسته‌های آماده TaHa را انتخاب کنید.</p>
          </div>

          <div className="theme-preset-grid">
            {[
              ["dark", "Graphite", "تیره کلاسیک"],
              ["light", "Light", "روشن"],
              ["midnight", "Midnight", "شبانه آبی"],
              ["ocean", "Ocean", "آبی عمیق"],
              ["glass", "Glass", "شیشه‌ای"],
              ["paper", "Paper", "کاغذی گرم"],
            ].map(([id, label, desc]) => (
              <button
                key={id}
                type="button"
                className={`theme-preset ${theme === id ? "selected" : ""}`}
                onClick={() => setTheme(id as typeof theme)}
              >
                <span className={`theme-swatch ${id}`} />
                <span>
                  <b>{label}</b>
                  <small>{desc}</small>
                </span>
              </button>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}

