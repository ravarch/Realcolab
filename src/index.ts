import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { nanoid } from "nanoid";
import { Env, WorkflowParams, DocumentChunk, AgentPlan, SearchResult } from "./types";

// --- Configuration ---
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_BATCH_SIZE = 20; // Workers AI batch limit for embeddings

export class AgentWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { type, payload } = event.payload;

    if (type === 'ingest') {
      return await this.runIngestionPipeline(payload, step);
    } else if (type === 'research') {
      return await this.runAgentPipeline(payload, step);
    }
    
    throw new Error(`Unknown event type: ${(event.payload as any).type}`);
  }

  // ==========================================
  // PIPELINE 1: High-Throughput Ingestion
  // ==========================================
  private async runIngestionPipeline(
    params: { content: string; sourceUrl?: string; metadata?: any }, 
    step: WorkflowStep
  ) {
    // Step 1: Initialize & Persist Document Metadata
    // We generate the ID inside the step to ensure replay determinism via the result cache
    const docMeta = await step.do("init-document", async () => {
      const docId = nanoid();
      const createdAt = Date.now();
      
      await this.env.DB.prepare(
        "INSERT INTO documents (id, source_url, created_at, metadata) VALUES (?, ?, ?, ?)"
      ).bind(
        docId, 
        params.sourceUrl || null, 
        createdAt, 
        JSON.stringify(params.metadata || {})
      ).run();

      return { docId };
    });

    // Step 2: Intelligent Chunking (CPU Bound)
    // Using LangChain for semantically aware splitting
    const chunks = await step.do("chunk-content", async () => {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 50,
      });
      
      const rawChunks = await splitter.createDocuments([params.content]);
      
      return rawChunks.map((c, i) => ({
        id: `${docMeta.docId}_${i}`,
        docId: docMeta.docId,
        content: c.pageContent,
        index: i
      } as DocumentChunk));
    });

    // Step 3: Vector Embeddings (Batch API) & Storage
    // We process the chunks in batches to respect AI model limits while maximizing throughput
    await step.do("embed-and-store", async () => {
      const totalChunks = chunks.length;
      
      // Process in chunks of MAX_BATCH_SIZE
      for (let i = 0; i < totalChunks; i += MAX_BATCH_SIZE) {
        const batch = chunks.slice(i, i + MAX_BATCH_SIZE);
        const batchTexts = batch.map(c => c.content);

        // 3a. Generate Embeddings (Batch API)
        const embeddingsResponse = await this.env.AI.run(EMBEDDING_MODEL, {
          text: batchTexts
        });

        // 3b. Prepare D1 Inserts
        const stmt = this.env.DB.prepare(
          "INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)"
        );
        const d1Batch = batch.map(c => stmt.bind(c.id, c.docId, c.index, c.content));

        // 3c. Prepare Vectorize Upserts
        const vectorizeBatch = batch.map((c, idx) => ({
          id: c.id,
          values: embeddingsResponse.data[idx],
          metadata: { docId: c.docId }
        }));

        // Execute IO in parallel for this batch
        await Promise.all([
          this.env.DB.batch(d1Batch),
          this.env.VECTORIZE.upsert(vectorizeBatch)
        ]);
      }

      return { processed: totalChunks };
    });

    return { status: "ingested", docId: docMeta.docId, chunks: chunks.length };
  }

  // ==========================================
  // PIPELINE 2: Autonomous Research Agent
  // ==========================================
  private async runAgentPipeline(
    params: { query: string; depth?: string }, 
    step: WorkflowStep
  ) {
    // Step 1: Plan - Decompose the Query
    // The Agent "thinks" about how to solve the user's request
    const plan = await step.do("agent-plan", async (): Promise<AgentPlan> => {
      const systemPrompt = `You are a Senior Research Agent. 
      Break down the user's query into 1-3 distinct, targeted search queries to gather comprehensive information.
      Return ONLY a JSON object with keys: "thoughtProcess" (string) and "subQueries" (string array).`;

      const response = await this.env.AI.run(GENERATION_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: params.query }
        ],
        response_format: { type: "json_object" }
      });

      // Parse safely
      try {
        const jsonStr = (response as any).response;
        return JSON.parse(jsonStr);
      } catch (e) {
        // Fallback if model fails strict JSON
        return { subQueries: [params.query], thoughtProcess: "Fallback to direct query." };
      }
    });

    // Step 2: Gather - Execute Parallel Vector Searches
    // We execute the plan. Each sub-query becomes a vector search.
    const searchResults = await step.do("agent-gather", async () => {
      // 2a. Embed all sub-queries in parallel (or batch if possible)
      const embeddingResponse = await this.env.AI.run(EMBEDDING_MODEL, {
        text: plan.subQueries
      });

      // 2b. Query Vectorize for each vector
      // Note: Vectorize query() is not batched in the same way, so we promise.all individual queries
      const searchPromises = embeddingResponse.data.map(async (vec, idx) => {
        const matches = await this.env.VECTORIZE.query(vec, { 
          topK: 3, 
          returnMetadata: true 
        });
        return matches.matches;
      });

      const allMatches = (await Promise.all(searchPromises)).flat();

      // 2c. Deduplicate results based on Chunk ID
      const uniqueIds = Array.from(new Set(allMatches.map(m => m.id)));
      if (uniqueIds.length === 0) return [];

      // 2d. Hydrate content from D1
      // Efficient "WHERE IN" query
      const placeholders = uniqueIds.map(() => "?").join(",");
      const stmt = this.env.DB.prepare(
        `SELECT c.id, c.content, d.source_url as sourceUrl 
         FROM chunks c 
         LEFT JOIN documents d ON c.document_id = d.id 
         WHERE c.id IN (${placeholders})`
      ).bind(...uniqueIds);
      
      const { results } = await stmt.all<any>();
      
      // Map back to scores
      return results.map(row => {
        const match = allMatches.find(m => m.id === row.id);
        return {
          id: row.id,
          content: row.content,
          sourceUrl: row.sourceUrl,
          score: match?.score || 0
        } as SearchResult;
      }).sort((a, b) => b.score - a.score); // Re-rank by score
    });

    // Step 3: Synthesize - Final Report
    const finalReport = await step.do("agent-synthesize", async () => {
      if (searchResults.length === 0) {
        return "I could not find any relevant information in the knowledge base to answer your query.";
      }

      const contextBlock = searchResults
        .map(r => `[Source: ${r.sourceUrl || 'Internal'} (ID: ${r.id})]\n${r.content}`)
        .join("\n\n");

      const systemPrompt = `You are a precise technical writer.
      Answer the user's question using ONLY the provided Context.
      You MUST cite the Source ID for every fact.
      Structure the answer with clear headings.
      
      Plan used: ${plan.thoughtProcess}`;

      const response = await this.env.AI.run(GENERATION_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Context:\n${contextBlock}\n\nUser Question: ${params.query}` }
        ]
      });

      return (response as any).response;
    });

    return {
      plan,
      sources: searchResults.map(s => s.sourceUrl).filter(Boolean),
      answer: finalReport
    };
  }
}

// --- API Handler ---
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Endpoint to trigger Ingestion
    if (req.method === "POST" && url.pathname === "/api/ingest") {
      const body = await req.json<any>();
      const instance = await env.MY_WORKFLOW.create({
        params: { type: 'ingest', payload: body }
      });
      return Response.json({ id: instance.id, status: "queued" });
    }

    // Endpoint to trigger Research Agent
    if (req.method === "POST" && url.pathname === "/api/research") {
      const body = await req.json<any>(); // { query: "..." }
      const instance = await env.MY_WORKFLOW.create({
        params: { type: 'research', payload: body }
      });
      return Response.json({ id: instance.id, status: "thinking" });
    }

    // Status Check
    if (req.method === "GET" && url.pathname === "/api/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ID", { status: 400 });
      
      try {
        const instance = await env.MY_WORKFLOW.get(id);
        const status = await instance.status();
        return Response.json(status);
      } catch (e) {
        return new Response("Instance Not Found", { status: 404 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
