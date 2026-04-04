import { chatCompletion } from "./llm-client";
import { resolveDocumentIndexPath } from "./manifest";
import { runQueryStage } from "./query-stage";
import {
  byteLength,
  findDocumentNodes,
  findLexicalNodeMatches,
  lightweightRootTree,
  logVerbose,
  parseJsonObject,
  readJson,
  stripText
} from "./query-utils";
import {
  DocumentRecord,
  PageIndexOptions,
  QuerySelectedDocument,
  Retriever,
  RetrieverContext,
  RetrievalResult,
  RootTreeNode
} from "./types";

type DocumentSelection = {
  documents: string[];
};

type NodeSelection = {
  nodes: string[];
};

type SelectionResult = {
  ids: string[];
  promptBytes: number;
  rawResponse: string;
  responseBytes: number;
};

async function selectDocuments(question: string, rootTree: RootTreeNode, options: PageIndexOptions): Promise<SelectionResult> {
  const prompt = `You are given a user question and a root documentation tree.
Each document node has:
- node_id
- title
- summary
- path
Select the documents most likely to contain the answer.
Return only valid JSON:
{
  "documents": ["node_id_1", "node_id_2"]
}
User question:
${question}
Root tree:
${JSON.stringify(lightweightRootTree(rootTree), null, 2)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], options);
  const parsed = parseJsonObject<DocumentSelection>(response);
  return {
    ids: Array.isArray(parsed.documents) ? parsed.documents.filter((id) => typeof id === "string") : [],
    promptBytes: byteLength(prompt),
    rawResponse: response,
    responseBytes: byteLength(response)
  };
}

async function selectPageIndexNodes(question: string, treeWithoutText: unknown, options: PageIndexOptions): Promise<SelectionResult> {
  const prompt = `You are given a user question and a document tree.
Each node has:
- node_id
- title
- summary
- child nodes
Select the nodes most likely to contain the answer.
Return only valid JSON:
{
  "nodes": ["node_id_1", "node_id_2"]
}
User question:
${question}
Document tree:
${JSON.stringify(treeWithoutText, null, 2)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], options);
  const parsed = parseJsonObject<NodeSelection>(response);
  return {
    ids: Array.isArray(parsed.nodes) ? parsed.nodes.filter((id) => typeof id === "string") : [],
    promptBytes: byteLength(prompt),
    rawResponse: response,
    responseBytes: byteLength(response)
  };
}

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function documentSkipReason(
  documentNode: RootTreeNode | undefined,
  manifestRecord: DocumentRecord | undefined,
  indexPath: string | undefined
): QuerySelectedDocument["skipReason"] | undefined {
  if (!documentNode) {
    return "missing_root_tree_document";
  }
  if (!manifestRecord) {
    return "missing_manifest_record";
  }
  if (!indexPath) {
    return "missing_index_path";
  }
  if (manifestRecord.status !== "ready") {
    return "document_not_ready";
  }
  return undefined;
}

export function createTreeRetriever(): Retriever {
  return {
    name: "tree",
    async retrieve(question: string, context: RetrieverContext, options: PageIndexOptions): Promise<RetrievalResult> {
      const warnings: string[] = [];
      const selectedDocuments: QuerySelectedDocument[] = [];
      const candidates: RetrievalResult["candidates"] = [];
      const documentIndexes: NonNullable<RetrievalResult["documentIndexes"]> = [];
      const timings = {
        selectDocuments: 0,
        selectNodes: 0
      };
      const trace: RetrievalResult["trace"] = {
        nodeSelections: [],
        failures: []
      };
      const documentNodes = findDocumentNodes(context.rootTree);
      const manifestByDocId = new Map<string, DocumentRecord>(context.manifest.documents.map((record) => [record.docId, record]));

      logVerbose(`query select documents total=${context.manifest.documents.length}`);
      const selectDocumentsStartedAt = Date.now();
      const documentSelection = await runQueryStage("select-documents", async () => await selectDocuments(question, context.rootTree, options));
      const selectedDocumentIds = documentSelection.ids;
      trace.documentSelection = {
        promptBytes: documentSelection.promptBytes,
        responseBytes: documentSelection.responseBytes,
        rawResponse: documentSelection.rawResponse,
        selectedDocumentIds
      };
      timings.selectDocuments = elapsedSince(selectDocumentsStartedAt);
      logVerbose(`query selected documents count=${selectedDocumentIds.length} ids=${selectedDocumentIds.join(",")}`);

      for (const docId of selectedDocumentIds) {
        const documentNode = documentNodes.get(docId);
        const manifestRecord = manifestByDocId.get(docId);
        const indexPath = documentNode?.index_path ?? manifestRecord?.indexPath;
        const available = Boolean(documentNode && manifestRecord && indexPath && manifestRecord.status === "ready");
        const skipReason = documentSkipReason(documentNode, manifestRecord, indexPath);

        const selectedDocument: QuerySelectedDocument = {
          docId,
          available,
          path: manifestRecord?.path ?? documentNode?.path,
          title: manifestRecord?.title ?? documentNode?.title,
          status: manifestRecord?.status,
          indexPath,
          selectionReason: "selected_by_document_planner"
        };
        if (skipReason) {
          selectedDocument.skipReason = skipReason;
        }
        selectedDocuments.push(selectedDocument);

        if (!available || !documentNode || !manifestRecord || !indexPath) {
          logVerbose(`query skip unavailable document id=${docId}`);
          warnings.push(`Selected document is unavailable: ${docId}`);
          trace.failures.push({
            stage: "read-document-index",
            code: skipReason ?? "document_unavailable",
            message: `Selected document is unavailable: ${docId}`,
            docId,
            path: manifestRecord?.path ?? documentNode?.path
          });
          continue;
        }

        logVerbose(`query read pageindex path=${manifestRecord.path}`);
        const pageIndexJson = await runQueryStage(
          "read-document-index",
          async () => await readJson<unknown>(resolveDocumentIndexPath(context.rootDir, indexPath, context.outputDir))
        );
        documentIndexes.push({
          docId,
          path: manifestRecord.path,
          indexPath,
          pageIndexJson
        });
        logVerbose(`query select nodes path=${manifestRecord.path}`);
        const selectNodesStartedAt = Date.now();
        const treeWithoutText = stripText(pageIndexJson);
        const nodeSelection = await runQueryStage("select-nodes", async () => await selectPageIndexNodes(question, treeWithoutText, options));
        const lexicalNodeIds = findLexicalNodeMatches(pageIndexJson, question);
        const selectedNodeIds = [...new Set([...nodeSelection.ids, ...lexicalNodeIds])];
        trace.nodeSelections.push({
          docId,
          path: manifestRecord.path,
          promptBytes: nodeSelection.promptBytes,
          responseBytes: nodeSelection.responseBytes,
          rawResponse: nodeSelection.rawResponse,
          selectedNodeIds
        });
        timings.selectNodes += elapsedSince(selectNodesStartedAt);
        logVerbose(`query selected nodes path=${manifestRecord.path} count=${selectedNodeIds.length} ids=${selectedNodeIds.join(",")}`);

        for (const nodeId of selectedNodeIds) {
          candidates.push({
            docId,
            path: manifestRecord.path,
            indexPath,
            nodeId,
            reference: `${manifestRecord.path}#${nodeId}`,
            retriever: "tree",
            reason: nodeSelection.ids.includes(nodeId) ? "selected_by_node_planner" : "matched_query_text",
            selectionReason: nodeSelection.ids.includes(nodeId) ? "selected_by_node_planner" : "matched_query_text"
          });
        }
      }

      return {
        retriever: "tree",
        candidates,
        documentIndexes,
        selectedDocuments,
        warnings,
        trace,
        timings
      };
    }
  };
}
