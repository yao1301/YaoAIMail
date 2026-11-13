import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getMessageWithHtml, getRenderedHtml } from "@/lib/api";
import { useUpdateFlagsMutation } from "@/hooks/mutations/useUpdateFlagsMutation";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import { inlineEmbeddedImages } from "@/lib/inlineImages";
import type { Message, RenderedHtml, PrivacyMode } from "@/lib/api";

export function useMessageLoader(messageId: string | null, privacyMode: PrivacyMode) {
  const flagsMutation = useUpdateFlagsMutation();
  const [message, setMessage] = useState<Message | null>(null);
  const [rendered, setRendered] = useState<RenderedHtml | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const privacyModeRef = useRef(privacyMode);
  const renderedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    privacyModeRef.current = privacyMode;
  }, [privacyMode]);

  const renderKey = (id: string, mode: PrivacyMode) => `${id}:${JSON.stringify(mode)}`;

  // Load message when messageId changes
  useEffect(() => {
    if (!messageId) {
      setMessage(null);
      setRendered(null);
      setError(null);
      renderedKeyRef.current = null;
      setLoading(false);
      return;
    }

    let cancelled = false;
    const initialPrivacyMode = privacyModeRef.current;
    const initialRenderKey = renderKey(messageId, initialPrivacyMode);
    setLoading(true);
    setMessage(null);
    setRendered(null);
    setError(null);
    renderedKeyRef.current = null;

    async function load() {
      try {
        const result = await getMessageWithHtml(messageId!, initialPrivacyMode);
        if (cancelled || !result) return;
        const [msg, html] = result;
        setMessage(msg);
        renderedKeyRef.current = initialRenderKey;
        const hydratedHtml = await inlineEmbeddedImages(html.html, msg.id);
        setRendered({ ...html, html: sanitizeHtml(hydratedHtml) });

        if (!cancelled && !msg.is_read) {
          flagsMutation.mutate({ messageId: messageId!, isRead: true });
        }
      } catch (err) {
        if (!cancelled) {
          // 后端可能 reject 普通对象（非 Error），统一序列化，避免显示 [object Object]
          let message: string;
          if (typeof err === "string") message = err;
          else if (err instanceof Error) message = err.message;
          else {
            try { message = JSON.stringify(err); } catch { message = "加载失败"; }
          }
          setError(message || "加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 后台补全正文完成（message:hydrated）→ 自动重新加载，正文无需手动刷新
  useEffect(() => {
    if (!messageId) return;
    const unlisten = listen<string>("message:hydrated", (event) => {
      if (event.payload !== messageId) return;
      const id = messageId;
      const mode = privacyModeRef.current;
      const key = renderKey(id, mode);
      void getMessageWithHtml(id, mode)
        .then((result) => {
          if (!result) return;
          const [msg, html] = result;
          setMessage(msg);
          renderedKeyRef.current = key;
          inlineEmbeddedImages(html.html, msg.id).then((h) =>
            setRendered({ ...html, html: sanitizeHtml(h) }),
          );
          setError(null);
          setHydrateFailed(false);
        })
        .catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 正文下载失败（网络/服务器问题）→ 显示轻量提示（不覆盖已显示的头部信息）
  const [hydrateFailed, setHydrateFailed] = useState(false);
  useEffect(() => {
    if (!messageId) {
      setHydrateFailed(false);
      return;
    }
    const unlisten = listen<string>("message:hydrate-failed", (event) => {
      if (event.payload !== messageId) return;
      setHydrateFailed(true);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render HTML when privacy mode changes (without reloading message)
  useEffect(() => {
    if (!message || !messageId || message.id !== messageId) return;
    const currentRenderKey = renderKey(messageId, privacyMode);
    if (renderedKeyRef.current === currentRenderKey) return;

    let cancelled = false;
    setRendered(null);
    setError(null);

    getRenderedHtml(messageId, privacyMode)
      .then((html) => {
        if (!cancelled) {
          renderedKeyRef.current = currentRenderKey;
          inlineEmbeddedImages(html.html, message.id).then((hydratedHtml) => {
            if (!cancelled) setRendered({ ...html, html: sanitizeHtml(hydratedHtml) });
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => { cancelled = true; };
  }, [privacyMode, messageId, message]); // eslint-disable-line react-hooks/exhaustive-deps

  return { message, setMessage, rendered, loading, error, hydrateFailed };
}
