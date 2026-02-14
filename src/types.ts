export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MY_WORKFLOW: Workflow;
}

// --- Workflow Event Payloads ---

export type IngestEvent = {
  type: 'ingest';
  payload: {
    content: string;
    sourceUrl?: string;
    metadata?: Record<string, unknown>;
  };
};

export type AgentEvent = {
  type: 'research';
  payload: {
    query: string;
    depth?: 'shallow' | 'deep';
  };
};

export type WorkflowParams = IngestEvent | AgentEvent;

// --- Internal Data Structures ---

export interface DocumentChunk {
  id: string;
  docId: string;
  content: string;
  index: number;
}

export interface AgentPlan {
  subQueries: string[];
  thoughtProcess: string;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  sourceUrl: string | null;
}
