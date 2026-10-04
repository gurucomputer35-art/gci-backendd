// Cloudflare Worker entry: /api/* goes to the backend, everything else is the website in ./public.
import { MongoClient } from "mongodb";
import { handle } from "./app.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    let client;
    const getDb = async () => {
      // A Worker cannot reuse a database connection across requests, so each API call opens one.
      client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      await client.connect();
      return client.db(env.MONGODB_DB || "GuruComputerWebsite");
    };
    const res = await handle(request, env, getDb);
    if (client) ctx.waitUntil(client.close());
    return res;
  },
};
