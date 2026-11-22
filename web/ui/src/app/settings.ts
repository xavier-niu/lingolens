// Settings: agent tokens and members, loaded when the page opens. The forms
// themselves keep their own state (SettingsView).
import { create } from "zustand"
import { api } from "@/lib/api.js"

export interface Token { id: string | number; name: string; hint: string; created_at: string; last_used_at?: string }
export interface Member { id: string | number; email: string; name?: string; is_admin?: boolean }

interface SettingsData {
  tokens: Token[]
  tokenError: string
  newToken: string // shown once, right after it's made
  members: Member[]
  memberStatus: string
}

export const useSettings = create<SettingsData>()(() => ({
  tokens: [], tokenError: "", newToken: "", members: [], memberStatus: "",
}))
const set = useSettings.setState

export async function loadTokens() {
  try {
    set({ tokens: await api("GET", "/api/me/tokens") })
  } catch (err: any) {
    set({ tokenError: err.message })
  }
}

export async function createToken(name: string) {
  set({ tokenError: "" })
  try {
    const res = await api("POST", "/api/me/tokens", { name: name.trim() })
    set({ newToken: `export LINGOLENS_URL=${res.endpoint}\nexport LINGOLENS_TOKEN=${res.token}` })
    loadTokens()
    return true
  } catch (err: any) {
    set({ tokenError: err.message })
    return false
  }
}

export async function revokeToken(id: string | number) {
  try {
    await api("DELETE", `/api/me/tokens/${encodeURIComponent(String(id))}`)
  } catch (err: any) {
    set({ tokenError: err.message })
    return
  }
  loadTokens()
}

// A token is shown once: leaving Settings forgets it.
export function resetTokenShown() {
  if (useSettings.getState().newToken) set({ newToken: "" })
}

export async function loadMembers() {
  try {
    set({ members: await api("GET", "/api/admin/users") })
  } catch (err: any) {
    set({ memberStatus: err.message })
  }
}

export const setMemberStatus = (memberStatus: string) => set({ memberStatus })

export function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

// Copies a code box; without clipboard access (plain http), selects it so
// Ctrl/Cmd+C works. Returns whether it was copied.
export async function copyText(text: string, box?: HTMLElement | null) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    if (box) getSelection()?.selectAllChildren(box)
    return false
  }
}
