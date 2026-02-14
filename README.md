# Realcolab: Serverless AI Research Agent

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)
![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-orange?logo=sqlite)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)
![Status](https://img.shields.io/badge/Status-Production%20Ready-success)
[![Telegram Channel](https://img.shields.io/badge/Telegram-Join%20Channel-2CA5E0?style=flat&logo=telegram&logoColor=white)](https://t.me/drkingbd)

**Realcolab** is an autonomous AI Agent capable of performing deep research tasks. Built on the Cloudflare stack, it leverages durable execution workflows to plan research strategies, execute parallel data gathering, and generate comprehensive, cited answers from your private knowledge base.

## 🚀 Key Features

* **🧠 Agentic Reasoning:** Instead of blindly searching, the agent analyzes the user's request and creates a research plan with specific sub-queries.
* **⚡ Parallel Execution:** Executes multiple vector search operations concurrently to gather diverse perspectives on a topic.
* **📝 Citation-Backed Answers:** Every claim in the final output is strictly cited against source documents stored in the database.
* **🔄 High-Throughput Ingestion:** dedicated pipeline using the **Workers AI Batch API** to embed and store large documents efficiently.
* **🛡️ Durable Orchestration:** Uses **Cloudflare Workflows** to ensure long-running tasks (like massive ingestions or multi-step research) complete reliably, even if they exceed standard timeout limits.

## 🏗️ Architecture

The system runs on two primary pipelines orchestrated by a single `AgentWorkflow` class:

### 1. Ingestion Pipeline
1.  **Chunking:** Intelligently splits raw text into semantic chunks using LangChain.
2.  **Embedding:** Generates vector embeddings in batches using `@cf/baai/bge-base-en-v1.5`.
3.  **Persistence:** Transactionally stores metadata in **D1** (SQL) and vectors in **Vectorize**.

### 2. Research Pipeline
1.  **Plan:** Llama 3.3 70B decomposes the query into 1-3 targeted sub-queries.
2.  **Gather:** The agent executes these sub-queries in parallel against the Vectorize index, re-ranking results by relevance.
3.  **Synthesize:** Retrieval context is hydrated from D1, and the model generates a final report citing specific source IDs.

## 🛠️ Tech Stack

* **Runtime:** Cloudflare Workers
* **Orchestration:** Cloudflare Workflows
* **Database:** Cloudflare D1 (SQLite)
* **Vector Database:** Cloudflare Vectorize
* **AI Models:**
    * *Reasoning:* `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
    * *Embeddings:* `@cf/baai/bge-base-en-v1.5`
* **Language:** TypeScript

## 📦 Installation & Setup

### Prerequisites
* Node.js & npm
* Cloudflare Wrangler CLI (`npm install -g wrangler`)
* A Cloudflare account with Workers AI enabled

### 1. Clone and Install
```bash
git clone [https://github.com/ravarch/realcolab.git](https://github.com/ravarch/realcolab.git)
cd realcolab
npm install

```

### 2. Provision Infrastructure

Create the D1 database and Vectorize index. Ensure the names match your `wrangler.jsonc`.

```bash
# Create D1 Database
wrangler d1 create agent-db

# Create Vectorize Index (Dimensions: 768 for BGE-Base)
wrangler vectorize create agent-memory --dimensions=768 --metric=cosine

```

*Note: Update `wrangler.jsonc` with the IDs generated from the commands above.*

### 3. Apply Database Migrations

Initialize the schema for documents and chunks.

```bash
wrangler d1 migrations apply agent-db --local
# OR for production
wrangler d1 migrations apply agent-db --remote

```

### 4. Deploy

```bash
wrangler deploy

```

## 🔌 API Reference

The Agent exposes a REST API for interaction.

### 📥 Ingest Document

Uploads content to the knowledge base.

**POST** `/api/ingest`

```json
{
  "content": "Full text content of the document...",
  "sourceUrl": "[https://example.com/article](https://example.com/article)",
  "metadata": {
    "author": "John Doe",
    "category": "Science"
  }
}

```

**Response:**

```json
{ "id": "workflow-instance-id", "status": "queued" }

```

### 🔎 Start Research

Triggers the autonomous research agent.

**POST** `/api/research`

```json
{
  "query": "What are the impacts of plastic pollution on marine life?"
}

```

**Response:**

```json
{ "id": "workflow-instance-id", "status": "thinking" }

```

### 📊 Check Status / Get Result

Poll this endpoint to retrieve the agent's progress and final answer.

**GET** `/api/status?id=<workflow-instance-id>`

**Response (Success):**

```json
{
  "status": "complete",
  "output": {
    "plan": {
      "thoughtProcess": "To answer this, I need to look for...",
      "subQueries": ["plastic ingestion statistics", "marine ecosystem impact"]
    },
    "answer": "Plastic pollution affects marine life by... [Source: ID_123]",
    "sources": ["[https://example.com/article](https://example.com/article)"]
  }
}

```

## 🛡️ Quality Gates

* **Deterministic IDs:** Document IDs are generated strictly within workflow steps to ensure replayability.
* **Batching:** Ingestion respects Workers AI batch limits (20 items/batch) to ensure stability.
* **Type Safety:** Fully typed event payloads and database responses.

## 📄 License

This project is licensed under the MIT License.
