// Tiny localStorage-backed store for LeadFinder development records.
// Each record represents one development action (e.g. "saved to customer
// manager", "wrote outreach email", etc.). Records can be listed and deleted.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface LeadDevRecord {
  id: string;
  email: string;
  companyName: string;
  action: string;
  note?: string;
  timestamp: number;
}

const STORAGE_KEY = "pebble-lead-dev-records-v1";
let remoteReady = false;
let hydratePromise: Promise<void> | null = null;

function readAll(): LeadDevRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object" && typeof item.id === "string");
  } catch {
    return [];
  }
}

function writeAll(records: LeadDevRecord[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 500)));
    if (remoteReady) void invoke("save_lead_dev_records", { records: records.slice(0, 500) }).catch(() => undefined);
  } catch {
    /* ignore quota */
  }
}

function hydrateFromDatabase(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = invoke<LeadDevRecord[] | null>("load_lead_dev_records").then((stored) => {
    const local = readAll();
    const records = Array.isArray(stored) ? stored : local;
    remoteReady = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 500)));
    if (stored === null && local.length > 0) void invoke("save_lead_dev_records", { records: local.slice(0, 500) }).catch(() => undefined);
    broadcast(records);
  }).catch(() => { remoteReady = true; });
  return hydratePromise;
}

let listeners: Array<(records: LeadDevRecord[]) => void> = [];

function broadcast(records: LeadDevRecord[]) {
  for (const fn of listeners) fn(records);
}

export function listLeadDevRecords(): LeadDevRecord[] {
  return readAll();
}

export function appendLeadDevRecord(record: Omit<LeadDevRecord, "id" | "timestamp">): LeadDevRecord {
  const all = readAll();
  const next: LeadDevRecord = {
    id: `ldr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...record,
  };
  const updated = [next, ...all].slice(0, 500);
  writeAll(updated);
  broadcast(updated);
  return next;
}

export function deleteLeadDevRecord(id: string): void {
  const all = readAll();
  const updated = all.filter((r) => r.id !== id);
  writeAll(updated);
  broadcast(updated);
}

export function clearLeadDevRecords(): void {
  writeAll([]);
  broadcast([]);
}

/** React hook that mirrors the localStorage-backed records. */
export function useLeadDevRecords() {
  const [records, setRecords] = useState<LeadDevRecord[]>(() => readAll());

  useEffect(() => {
    const fn = (next: LeadDevRecord[]) => setRecords(next);
    listeners.push(fn);
    void hydrateFromDatabase();
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  }, []);

  const append = useCallback(
    (record: Omit<LeadDevRecord, "id" | "timestamp">) => appendLeadDevRecord(record),
    [],
  );
  const remove = useCallback((id: string) => deleteLeadDevRecord(id), []);
  const clear = useCallback(() => clearLeadDevRecords(), []);
  return { records, append, remove, clear };
}
