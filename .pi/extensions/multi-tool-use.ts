/**
 * Dependent Multi-Tool Extension
 *
 * Registers `multi_tool_use_seq_dependent`, a composite tool that runs other
 * active tools in order via `ctx.runTool(...)`. This keeps orchestration
 * policy in an extension while core provides only the minimal callback into
 * pi's normal tool lookup, validation, and execution path.
 */
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const dependentCallSchema = Type.Object({
	tool: Type.String({ description: "Tool name to execute." }),
	arguments: Type.Record(Type.String(), Type.Unknown(), {
		description:
			'Arguments object for that tool. Put the target tool parameters inside this nested \'arguments\' object, e.g. { "tool": "read", "arguments": { "path": "file.txt" } }.',
	}),
});

const seqDependentSchema = Type.Object({
	calls: Type.Array(dependentCallSchema, {
		description:
			'Ordered tool calls. Each item must have the shape { tool: string, arguments: object }. Calls execute in order and stop on the first error.',
		minItems: 1,
	}),
});

function contentToText(content: AgentToolResult["content"]): string {
	const text = content
		.filter((block): block is { type: string; text: string } => "text" in block && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || "(no text output)";
}

interface OrchestrationStep {
	tool: string;
	isError: boolean;
	contentText: string;
}

function appendOrchestrationEntry(
	pi: ExtensionAPI,
	customType: string,
	toolCallId: string,
	calls: Array<{ tool: string; arguments: Record<string, unknown> }>,
	steps: OrchestrationStep[],
	stoppedEarly: boolean,
	failedTool?: string,
): void {
	pi.appendEntry(customType, {
		toolCallId,
		calls,
		steps,
		stoppedEarly,
		failedTool,
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "multi_tool_use_seq_dependent",
		label: "Seq Dependent",
		description:
			"Execute dependent tool calls sequentially in one wrapper call. Stops on the first error and returns completed step outputs.",
		promptSnippet:
			'Run dependent tool calls sequentially in one wrapper call. Each calls item must be shaped like { tool: "name", arguments: { ... } }. Prefer batching predictable next steps to avoid extra tool-call overhead. Stop on the first error.',
		promptGuidelines: [
			"Each tool call has overhead because the model must re-read context/cache. Avoid unnecessary one-tool-at-a-time round trips.",
			"If multi-tool wrapper tools are available, think 2-3 steps ahead and batch the next independent or mechanically dependent calls when you do not need to inspect intermediate results before deciding the next action.",
			"Use parallel multi-tool wrappers for independent calls. Use sequential/dependent multi-tool wrappers for ordered calls that depend on earlier steps but do not require reflection on intermediate output.",
			"Each tool call has system overhead because the model must re-read context/cache. Prefer one multi_tool_use_seq_dependent call over multiple single-tool round trips when the next steps are already clear.",
			"Think about the next 2-3 steps before using tools. If the next ordered actions are predictable, batch them into one wrapper call.",
			"Use multi_tool_use_seq_dependent when later tool calls depend on earlier ones (for example edit/write then test), but not when you need to inspect or reflect on intermediate output before deciding the next action.",
			"Provide calls in execution order. This wrapper stops on the first tool error and does not run later steps.",
			"Each calls entry must be an object with exactly two fields: tool and arguments. Put the target tool parameters inside arguments.",
			'Example: { "calls": [ { "tool": "write", "arguments": { "path": "a.txt", "content": "hello" } }, { "tool": "read", "arguments": { "path": "a.txt" } } ] }',
		],
		parameters: seqDependentSchema,
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const steps: OrchestrationStep[] = [];
			for (let index = 0; index < params.calls.length; index++) {
				const call = params.calls[index];
				if (call.tool === "multi_tool_use_seq_dependent") {
					const contentText = "Recursive multi_tool_use_seq_dependent calls are not allowed";
					steps.push({ tool: call.tool, isError: true, contentText });
					appendOrchestrationEntry(
						pi,
						"multi_tool_use_seq_dependent",
						toolCallId,
						params.calls,
						steps,
						true,
						call.tool,
					);
					return {
						content: [{ type: "text", text: contentText }],
						details: { steps, stoppedEarly: true, failedTool: call.tool },
					};
				}

				const executed = await ctx.runTool(call.tool, call.arguments, {
					toolCallId: `${toolCallId}_${index + 1}`,
					signal,
				});
				const contentText = contentToText(executed.result.content);
				steps.push({ tool: call.tool, isError: executed.isError, contentText });

				if (executed.isError) {
					const lines = steps.map(
						(step, stepIndex) =>
							`${stepIndex + 1}. ${step.tool}${step.isError ? " [error]" : ""}\n${step.contentText}`,
					);
					appendOrchestrationEntry(
						pi,
						"multi_tool_use_seq_dependent",
						toolCallId,
						params.calls,
						steps,
						true,
						call.tool,
					);
					return {
						content: [
							{
								type: "text",
								text: `Stopped after tool ${index + 1} (${call.tool}) failed.\n\n${lines.join("\n\n")}`,
							},
						],
						details: { steps, stoppedEarly: true, failedTool: call.tool },
					};
				}
			}

			const lines = steps.map((step, stepIndex) => `${stepIndex + 1}. ${step.tool}\n${step.contentText}`);
			appendOrchestrationEntry(pi, "multi_tool_use_seq_dependent", toolCallId, params.calls, steps, false);
			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: { steps, stoppedEarly: false },
			};
		},
	});
}
