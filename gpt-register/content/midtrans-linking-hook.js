// content/midtrans-linking-hook.js — MAIN world: records Midtrans Snap /accounts/{id}/linking requests and replays without Authorization.
(function installMultiPageMidtransLinkingHook() {
  try {
    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const FLAG = '__MULTIPAGE_midtransLinkingHookInstalled__';
    if (root[FLAG]) {
      return;
    }
    root[FLAG] = true;

    function getStore() {
      try {
        const tw = window.top;
        if (!tw.__MULTIPAGE_midtransLinkingStore) {
          tw.__MULTIPAGE_midtransLinkingStore = { lastRequest: null };
        }
        return tw.__MULTIPAGE_midtransLinkingStore;
      } catch (_) {
        if (!root.__MULTIPAGE_midtransLinkingStore) {
          root.__MULTIPAGE_midtransLinkingStore = { lastRequest: null };
        }
        return root.__MULTIPAGE_midtransLinkingStore;
      }
    }

    function isMidtransLinkingUrl(absoluteUrl) {
      if (!absoluteUrl) {
        return false;
      }
      try {
        const u = new URL(String(absoluteUrl).split('#')[0], 'https://app.midtrans.com/');
        if (!/^app\.midtrans\.com$/i.test(u.hostname || '')) {
          return false;
        }
        return /\/snap\/v\d+\/accounts\/[^/]+\/linking$/i.test(u.pathname || '');
      } catch (_) {
        return false;
      }
    }

    function headersToPlain(headers) {
      const out = {};
      if (!headers) {
        return out;
      }
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => {
          out[key] = value;
        });
        return out;
      }
      if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => {
          if (k) out[String(k)] = String(v);
        });
        return out;
      }
      if (typeof headers === 'object') {
        Object.keys(headers).forEach((k) => {
          out[k] = headers[k];
        });
      }
      return out;
    }

    function recordFromFetchParts(absoluteUrl, method, headersPlain, body) {
      const store = getStore();
      store.lastRequest = {
        url: absoluteUrl,
        method: String(method || 'GET').toUpperCase(),
        headers: { ...headersPlain },
        body: body == null ? '' : String(body),
        recordedAt: Date.now(),
      };
    }

    const nativeFetch = root.fetch ? root.fetch.bind(root) : null;

    if (typeof nativeFetch === 'function') {
      root.fetch = async function multipageMidtransFetchWrapper(input, init) {
        const opts = init ? { ...init } : {};
        let absoluteUrl = '';
        let method = String(opts.method || 'GET').toUpperCase();
        let headersPlain = headersToPlain(opts.headers);

        try {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            absoluteUrl = new URL(input.url.split('#')[0], location.href).href;
            method = String(input.method || method).toUpperCase();
            headersPlain = headersToPlain(new Headers(input.headers));
          } else {
            const raw = typeof input === 'string' ? input : (input && input.url);
            absoluteUrl = new URL(String(raw || '').split('#')[0], location.href).href;
          }
        } catch (_) {
          absoluteUrl = '';
        }

        if (absoluteUrl && isMidtransLinkingUrl(absoluteUrl)) {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            let bodyText = '';
            try {
              bodyText = await input.clone().text();
            } catch (_) {}
            recordFromFetchParts(absoluteUrl, method, headersPlain, bodyText);
          } else {
            recordFromFetchParts(absoluteUrl, method, headersPlain, opts.body);
          }
        }

        return nativeFetch(input, init);
      };
    }

    const { open: xhrOpen, send: xhrSend, setRequestHeader: xhrSetRequestHeader } = XMLHttpRequest.prototype;

    XMLHttpRequest.prototype.open = function multipageMidtransOpen(method, url, ...rest) {
      this.__multipageMethod = String(method || 'GET').toUpperCase();
      this.__multipageUrl = String(url || '');
      this.__multipageHeaders = {};
      return xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function multipageMidtransSetRequestHeader(name, value) {
      this.__multipageHeaders = this.__multipageHeaders || {};
      this.__multipageHeaders[String(name)] = String(value);
      return xhrSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function multipageMidtransSend(body) {
      try {
        const absoluteUrl = new URL(String(this.__multipageUrl || '').split('#')[0], location.href).href;
        if (isMidtransLinkingUrl(absoluteUrl)) {
          const store = getStore();
          store.lastRequest = {
            url: absoluteUrl,
            method: String(this.__multipageMethod || 'POST').toUpperCase(),
            headers: { ...(this.__multipageHeaders || {}) },
            body: body == null ? '' : String(body),
            recordedAt: Date.now(),
          };
        }
      } catch (_) {}
      return xhrSend.call(this, body);
    };

    root.__MULTIPAGE_midtransReplayLinkingWithoutAuth__ = async function replayMidtransLinkingWithoutAuth(opts) {
      const options = opts && typeof opts === 'object' ? opts : {};
      const skipWindowOpen = Boolean(options.skipWindowOpen || options.skipTabOpen);
      const store = getStore();
      const last = store && store.lastRequest;
      if (!last || !last.url) {
        return { ok: false, error: 'no_recorded_linking_request' };
      }
      if (Date.now() - (last.recordedAt || 0) > 15 * 60 * 1000) {
        return { ok: false, error: 'linking_request_stale' };
      }

      const headers = new Headers();
      Object.keys(last.headers || {}).forEach((key) => {
        const lk = String(key).toLowerCase();
        if (lk === 'authorization') {
          return;
        }
        headers.set(key, last.headers[key]);
      });

      const init = {
        method: last.method || 'POST',
        headers,
        credentials: 'include',
        mode: 'cors',
        cache: 'no-store',
      };
      if (last.body) {
        init.body = last.body;
      }

      let res;
      try {
        res = await nativeFetch(last.url, init);
      } catch (err) {
        return { ok: false, error: `fetch_failed:${String(err && err.message ? err.message : err)}` };
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        return { ok: false, error: 'invalid_json', httpStatus: res.status, preview: text.slice(0, 240) };
      }

      const link = String(json.activation_link_url || json.activationLinkUrl || '').trim();
      if (!link) {
        return { ok: false, error: 'missing_activation_link_url', httpStatus: res.status, json };
      }

      store.lastRequest = null;

      if (!skipWindowOpen) {
        try {
          window.open(link, '_blank', 'noopener,noreferrer');
        } catch (err) {
          return {
            ok: false,
            error: `window_open_failed:${String(err && err.message ? err.message : err)}`,
            activation_link_url: link,
          };
        }
      }

      return {
        ok: true,
        activation_link_url: link,
        status_code: json.status_code,
        account_status: json.account_status,
        httpStatus: res.status,
        skipWindowOpen,
      };
    };
  } catch (err) {
    console.warn('[MultiPage:midtrans-linking-hook] install failed', err);
  }
}());
