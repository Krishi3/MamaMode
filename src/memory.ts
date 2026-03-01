import { MongoClient } from "mongodb";

type MemoryDoc = {
  phone: string;
  name?: string;
  babyAgeWeeks?: number;
  feeding?: string;
  recovery?: string;
  location?: string;
  updatedAt: Date;
};

let client: MongoClient | null = null;

export async function getDb(uri: string, dbName: string) {
  if (!uri) throw new Error("Missing MONGODB_URI");
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db(dbName);
}

export async function loadMemory(opts: { uri?: string; dbName?: string; phone: string }) {
  if (!opts.uri || !opts.dbName) return null;
  const db = await getDb(opts.uri, opts.dbName);
  return await db.collection<MemoryDoc>("memory").findOne({ phone: opts.phone });
}

export async function saveMemory(opts: {
  uri?: string;
  dbName?: string;
  phone: string;
  patch: Partial<MemoryDoc>;
}) {
  if (!opts.uri || !opts.dbName) return;
  const db = await getDb(opts.uri, opts.dbName);
  await db.collection<MemoryDoc>("memory").updateOne(
    { phone: opts.phone },
    { $set: { ...opts.patch, phone: opts.phone, updatedAt: new Date() } },
    { upsert: true }
  );
}