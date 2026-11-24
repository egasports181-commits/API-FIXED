import { DEFAULT_TIMEOUT_MS } from "./http.js";

const sessions = new Map();

function sessionKey(name, browser, os) {
  return `${name}:${browser}:${os}`;
}

async function getSession(name, browser, os) {
  const key = sessionKey(name, browser, os);
  let current = sessions.get(key);
  if (!current) {
    current = import("wreq-js")
      .then(({ createSession }) => createSession({ browser, os }))
      .catch((error) => {
        sessions.delete(key);
        const wrapped = new Error(`wreq-js session unavailable: ${error?.message ?? error}`);
        wrapped.cause = error;
        throw wrapped;
      });
    sessions.set(key, current);
  }
  return current;
}

export async function wreqFetch(url, options = {}) {
  if (process.env.WREQ_DISABLED === "1") {
    throw new Error("wreq-js disabled via WREQ_DISABLED=1");
  }
  const {
    session = "default",
    browser = "chrome_149",
    os = "windows",
    warm = [],
    timeout = DEFAULT_TIMEOUT_MS,
    ...request
  } = options;
  const client = await getSession(session, browser, os);
  for (const item of warm) {
    await client.fetch(item.url, {
      method: item.method ?? "GET",
      headers: item.headers,
      body: item.body,
      redirect: item.redirect ?? "follow",
      timeout: item.timeout ?? timeout,
    });
  }
  return client.fetch(url, {
    redirect: "follow",
    timeout,
    ...request,
  });
}

export async function closeWreqSessions() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map(async (current) => {
    const client = await current;
    if (client && typeof client.close === "function") {
      await client.close();
    }
  }));
}
