import { create } from 'zustand'
import type { DocumentMeta } from '@/types'

interface UserState {
  /** 本地文档列表（离线模式，不依赖后端） */
  documents: DocumentMeta[]
  setDocuments: (docs: DocumentMeta[]) => void
  addDocument: (doc: DocumentMeta) => void
  removeDocument: (id: string) => void
  updateDocument: (id: string, patch: Partial<DocumentMeta>) => void
}

export const useUserStore = create<UserState>((set) => ({
  documents: [],
  setDocuments: (docs) => set({ documents: docs }),
  addDocument: (doc) => set((state) => ({ documents: [doc, ...state.documents] })),
  removeDocument: (id) =>
    set((state) => ({ documents: state.documents.filter((d) => d.id !== id) })),
  updateDocument: (id, patch) =>
    set((state) => ({
      documents: state.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
}))
