import type { ConversationMessage } from './app-types';
import type { NormalizedAnswer } from './answer-shape';
import type { ExportTable } from './export-serializers';
import {
  safeExportFilename,
  serializeAnswerMarkdown,
  serializeConversationMarkdown,
  serializeTableTsv,
} from './export-serializers';
import { copyExportText, downloadExportBlob, downloadExportText } from './export-files';

function answerExport(answer: NormalizedAnswer, question: string) {
  const markdown = serializeAnswerMarkdown(question, answer);
  const filename = safeExportFilename(question || answer.takeaway, 'md');
  return { markdown, filename };
}

export async function copyAnswerMarkdown(answer: NormalizedAnswer, question: string): Promise<void> {
  await copyExportText(answerExport(answer, question).markdown);
}

export function downloadAnswerMarkdown(answer: NormalizedAnswer, question: string): void {
  const { markdown, filename } = answerExport(answer, question);
  downloadExportText(markdown, filename);
}

export async function downloadAnswerPdf(answer: NormalizedAnswer, question: string): Promise<void> {
  const { markdown, filename } = answerExport(answer, question);
  const { markdownPdf } = await import('./export-binary');
  downloadExportBlob(markdownPdf(markdown), filename.replace(/\.md$/, '.pdf'));
}

export async function copyTableTsv(table: ExportTable): Promise<void> {
  await copyExportText(serializeTableTsv(table));
}

export async function downloadTablePng(table: ExportTable, name: string): Promise<void> {
  const { tablePng } = await import('./export-binary');
  const filename = safeExportFilename(name, 'png');
  downloadExportBlob(await tablePng(table), filename);
}

export async function downloadTablePdf(table: ExportTable, name: string): Promise<void> {
  const { tablePdf } = await import('./export-binary');
  const filename = safeExportFilename(name, 'pdf');
  downloadExportBlob(tablePdf(table), filename);
}

async function conversationExport(title: string, loadMessages: () => Promise<ConversationMessage[]>) {
  const markdown = serializeConversationMarkdown(title, await loadMessages());
  const filename = safeExportFilename(title, 'md');
  return { markdown, filename };
}

export async function copyConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  await copyExportText((await conversationExport(title, loadMessages)).markdown);
}

export async function downloadConversationMarkdown(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const { markdown, filename } = await conversationExport(title, loadMessages);
  downloadExportText(markdown, filename);
}

export async function downloadConversationPdf(
  title: string,
  loadMessages: () => Promise<ConversationMessage[]>
): Promise<void> {
  const { markdown, filename } = await conversationExport(title, loadMessages);
  const { markdownPdf } = await import('./export-binary');
  downloadExportBlob(markdownPdf(markdown), filename.replace(/\.md$/, '.pdf'));
}
