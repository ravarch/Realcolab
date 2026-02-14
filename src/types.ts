export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MY_WORKFLOW: Workflow;
}

export type RAGParams = 
  | { operation: 'ingest'; id: string; content: string; sourceUrl?: string; metadata?: Record<string,any> }
  | { operation: 'query'; query: string; topK?: number };

export interface RAGResult {
  answer?: string;
  sources?: Array<{ id: string; score: number; content: string }>;
  stats?: { processedDocs?: number };
}
