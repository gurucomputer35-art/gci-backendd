// Cloudflare Worker entry. Files in ./public are served directly by Cloudflare;
// everything else (API, pages, sitemap) goes through handleRequest.
import { MongoClient } from "mongodb";
import { handleRequest } from "./worker.js";

export default {
  async fetch(request, env, ctx) {
    let client;
    const getDb = async () => {
      if (!client) {
        if (!env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
        // A Worker cannot reuse a database connection across requests, so each request opens one when it needs it.
        client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
        await client.connect();
      }
      return client.db(env.MONGODB_DB || "GuruComputerWebsite");
    };
    try {
      return await handleRequest(request, env, ctx, getDb);
    } finally {
      if (client) ctx.waitUntil(client.close().catch(() => {}));
    }
  },
};
