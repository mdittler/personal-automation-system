import type { AlertDefinition } from '../../types/alert.js';
import type { ReportDefinition } from '../../types/report.js';

export const formatReportLines = (reports: ReportDefinition[]): string =>
	reports.map((r) => `- ${r.name} (${r.schedule ?? 'manual'})`).join('\n');

export const formatAlertLines = (alerts: AlertDefinition[]): string =>
	alerts.map((a) => `- ${a.name}`).join('\n');
