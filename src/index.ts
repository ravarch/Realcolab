import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { nanoid } from "nanoid";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MY_WORKFLOW: Workflow;
}

// --- Types ---
type IngestParams = {
  operation: "ingest";
  id?: string;
  content: string;
  sourceUrl?: string;
  metadata?: Record<string, string>;
};

type QueryParams = {
  operation: "query";
  query: string;
  topK?: number;
};

type Params = IngestParams | QueryParams;

// --- Constants ---
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class RAGWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = event.payload;

    if (params.operation === "ingest") {
      return await this.handleIngestion(params, step);
    } else if (params.operation === "query") {
      return await this.handleQuery(params, step);
    } else {
      throw new Error("Unknown operation");
    }
  }

  // --- Pipeline: Ingestion ---
  private async handleIngestion(params: IngestParams, step: WorkflowStep) {
    const docId = params.id || nanoid();
    
    // Step 1: Chunking (CPU bound, strictly synchronous logic)
    const chunks = await step.do("chunk-document", async () => {
      // Simple recursive-like splitter simulation
      // In production, use a library like `langchain/text_splitter` adapted for Workers
      const CHUNK_SIZE = 500; // chars approx
      const text = params.content;
      const chunksArr: string[] = [];
      
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunksArr.push(text.slice(i, i + CHUNK_SIZE));
      }
      
      return chunksArr.map((content, index) => ({
        id: `${docId}_${index}`,
        docId,
        index,
        content
      }));
    });

    // Step 2: Generate Embeddings (AI bound)
    // We process in batches to avoid API limits
    const vectors = await step.do("embed-chunks", async () => {
      const BATCH_SIZE = 5;
      const allVectors: any[] = [];

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await this.env.AI.run(EMBEDDING_MODEL, {
          text: batch.map(c => c.content)
        });

        // Map embeddings back to chunk IDs
        batch.forEach((chunk, idx) => {
          allVectors.push({
            id: chunk.id,
            values: embeddings.data[idx],
            metadata: {
              docId: chunk.docId,
              source: params.sourceUrl || "raw",
            }
          });
        });
      }
      return allVectors;
    });

    // Step 3: Transactional Storage (IO bound)
    await step.do("persist-data", async () => {
      // A. Store Metadata & Text in D1
      const batchStmts = [
        this.env.DB.prepare(
          "INSERT OR REPLACE INTO documents (id, source_url, created_at, metadata) VALUES (?, ?, ?, ?)"
        ).bind(docId, params.sourceUrl || null, Date.now(), JSON.stringify(params.metadata || {})),
      ];

      for (const chunk of chunks) {
        batchStmts.push(
          this.env.DB.prepare(
            "INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)"
          ).bind(chunk.id, chunk.docId, chunk.index, chunk.content)
        );
      }

      await this.env.DB.batch(batchStmts);

      // B. Store Vectors in Vectorize
      // Vectorize supports upserting up to 1000 vectors at once
      await this.env.VECTORIZE.upsert(vectors);
    });

    return { status: "success", docId, chunksProcessed: chunks.length };
  }

  // --- Pipeline: Deep Research Query ---
  private async handleQuery(params: QueryParams, step: WorkflowStep) {
    // Step 1: Embed the Query
    const queryVector = await step.do("embed-query", async () => {
      const resp = await this.env.AI.run(EMBEDDING_MODEL, {
        text: [params.query]
      });
      return resp.data[0];
    });

    // Step 2: Vector Search
    const matches = await step.do("search-index", async () => {
      return await this.env.VECTORIZE.query(queryVector, {
        topK: params.topK || 5,
        returnMetadata: true
      });
    });

    if (matches.matches.length === 0) {
      return { answer: "I couldn't find any relevant information in the knowledge base.", sources: [] };
    }

    // Step 3: Hydrate Context (Fetch full text from D1)
    const context = await step.do("fetch-context", async () => {
      const chunkIds = matches.matches.map(m => m.id);
      // D1 "WHERE id IN (...)" construction
      const placeholders = chunkIds.map(() => "?").join(",");
      const stmt = this.env.DB.prepare(
        `SELECT id, content, document_id FROM chunks WHERE id IN (${placeholders})`
      ).bind(...chunkIds);
      
      const { results } = await stmt.all<{ id: string, content: string, document_id: string }>();
      
      // Map results back to scores
      return results.map(row => ({
        ...row,
        score: matches.matches.find(m => m.id === row.id)?.score || 0
      })).sort((a, b) => b.score - a.score);
    });

    // Step 4: Generate Answer
    const answer = await step.do("generate-answer", async () => {
      const contextBlock = context.map(c => `[Source ID: ${c.id}]\n${c.content}`).join("\n\n");
      
      const systemPrompt = `You are an expert research assistant. 
      Answer the user's question strictly based on the provided context below.
      Cite the Source ID for every claim you make.
      If the context does not contain the answer, admit it.`;

      const resp = await this.env.AI.run(GENERATION_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Context:\n${contextBlock}\n\nQuestion: ${params.query}` }
        ]
      });

      return resp;
    });

    return {
      answer: (answer as any).response,
      sources: context.map(c => ({ id: c.id, score: c.score }))
    };
  }
}

// --- Worker Entrypoint for API Access ---
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    
    // Simple Router
    if (req.method === "POST" && url.pathname === "/rag") {
      const payload = await req.json<Params>();
      
      // Spawn Workflow
      const instance = await env.MY_WORKFLOW.create({
        params: payload
      });

      return Response.json({
        id: instance.id,
        statusUrl: `/status?id=${instance.id}`,
        message: "RAG Task Queued"
      });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if(!id) return new Response("Missing ID", { status: 400 });
      
      const instance = await env.MY_WORKFLOW.get(id);
      const status = await instance.status();
      
      return Response.json(status);
    }

    return new Response("Not Found", { status: 404 });
  }
};
