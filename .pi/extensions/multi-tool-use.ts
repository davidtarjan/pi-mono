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
			"Batch a chain of dependent tool calls into a single round trip. Use this when the next 2-3 steps are predictable and must run in order (e.g. write a file then run its tests), but you do not need to inspect intermediate output before deciding the next action. Stops on the first error.",
		promptGuidelines: [
			"Cache re-reads are the majority of the cost of running the agent — every individual tool call forces a full re-read of the conversation context. Batching 2-3 predictable steps into one wrapper call eliminates those extra re-reads and dramatically reduces total cost.",
			"Use this tool when calls must execute in order because later steps depend on earlier ones (e.g. edit → test, write → read-back). Use multi_tool_use_parallel instead when calls are independent. Use neither when you need to read and reason about intermediate output before deciding what to do next.",
			"Calls execute in the order given. The wrapper stops on the first tool error and returns all completed outputs up to that point; later steps are skipped.",
			'Each entry in calls must have exactly two fields: tool (string) and arguments (object with that tool\'s parameters). Example: { "calls": [ { "tool": "write", "arguments": { "path": "a.txt", "content": "hello" } }, { "tool": "read", "arguments": { "path": "a.txt" } } ] }',
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
