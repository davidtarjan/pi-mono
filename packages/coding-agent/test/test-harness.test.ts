/**
 * Tests for the test harness itself.
 * Validates that the faux provider and session factory work correctly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.js";

describe("test harness", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("simple text response", async () => {
		harness = createHarness({ responses: ["hello world"] });

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(1);

		const assistantMessages = harness.session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);

		const msg = assistantMessages[0] as AssistantMessage;
		expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(msg.stopReason).toBe("stop");
	});

	it("response sequence", async () => {
		harness = createHarness({ responses: ["first", "second", "third"] });

		await harness.session.prompt("a");
		await harness.session.prompt("b");
		await harness.session.prompt("c");

		expect(harness.faux.callCount).toBe(3);

		const assistantTexts = harness.session.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map((m) => m.content.find((c) => c.type === "text")?.text);

		expect(assistantTexts).toEqual(["first", "second", "third"]);
	});

	it("tool call response triggers tool execution", async () => {
		let toolExecuted = false;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};

		harness = createHarness({
			responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, "done after tool"],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("use the tool");

		expect(toolExecuted).toBe(true);
		expect(harness.faux.callCount).toBe(2);

		const toolResults = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
	});

	it("error response", async () => {
		harness = createHarness({
			responses: [{ error: "something broke" }],
		});

		await harness.session.prompt("hi");

		const assistantMessages = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].stopReason).toBe("error");
		expect(assistantMessages[0].errorMessage).toBe("something broke");
	});

	it("retry on transient error", async () => {
		harness = createHarness({
			responses: [{ error: "overloaded_error" }, "recovered"],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(2);

		const retryStarts = harness.eventsOfType("auto_retry_start");
		expect(retryStarts).toHaveLength(1);

		const retryEnds = harness.eventsOfType("auto_retry_end");
		expect(retryEnds).toHaveLength(1);
		expect(retryEnds[0].success).toBe(true);
	});

	it("custom usage numbers", async () => {
		harness = createHarness({
			responses: [{ text: "big response", usage: { input: 100000, output: 5000 } }],
		});

		await harness.session.prompt("hi");

		const msg = harness.session.messages.find((m): m is AssistantMessage => m.role === "assistant")!;
		expect(msg.usage.input).toBe(100000);
		expect(msg.usage.output).toBe(5000);
	});

	it("event capture", async () => {
		harness = createHarness({ responses: ["hello"] });

		await harness.session.prompt("hi");

		const agentStarts = harness.eventsOfType("agent_start");
		expect(agentStarts).toHaveLength(1);

		const agentEnds = harness.eventsOfType("agent_end");
		expect(agentEnds).toHaveLength(1);

		const messageEnds = harness.eventsOfType("message_end");
		expect(messageEnds.length).toBeGreaterThanOrEqual(2); // user + assistant
	});

	it("context capture", async () => {
		harness = createHarness({ responses: ["reply"] });

		await harness.session.prompt("my question");

		expect(harness.faux.contexts).toHaveLength(1);
		const ctx = harness.faux.contexts[0];
		const userMsg = ctx.messages.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
	});

	it("wraps around when more calls than responses", async () => {
		harness = createHarness({ responses: ["a", "b"] });

		await harness.session.prompt("1");
		await harness.session.prompt("2");
		await harness.session.prompt("3");

		expect(harness.faux.callCount).toBe(3);

		const texts = harness.session.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map((m) => m.content.find((c) => c.type === "text")?.text);

		expect(texts).toEqual(["a", "b", "a"]);
	});

	it("streams text deltas", async () => {
		harness = createHarness({ responses: ["hello world"] });

		await harness.session.prompt("hi");

		const updates = harness.eventsOfType("message_update");
		const textDeltas = updates.filter((e) => e.assistantMessageEvent.type === "text_delta");
		expect(textDeltas.length).toBeGreaterThan(0);

		// Deltas should reconstruct the full text
		const reconstructed = textDeltas.map((e) => (e.assistantMessageEvent as { delta: string }).delta).join("");
		expect(reconstructed).toBe("hello world");
	});

	it("streams thinking deltas", async () => {
		harness = createHarness({
			responses: [{ thinking: "let me think about this", text: "answer" }],
		});

		await harness.session.prompt("hi");

		const updates = harness.eventsOfType("message_update");
		const thinkingStarts = updates.filter((e) => e.assistantMessageEvent.type === "thinking_start");
		const thinkingDeltas = updates.filter((e) => e.assistantMessageEvent.type === "thinking_delta");
		const thinkingEnds = updates.filter((e) => e.assistantMessageEvent.type === "thinking_end");

		expect(thinkingStarts).toHaveLength(1);
		expect(thinkingDeltas.length).toBeGreaterThan(0);
		expect(thinkingEnds).toHaveLength(1);

		const reconstructed = thinkingDeltas.map((e) => (e.assistantMessageEvent as { delta: string }).delta).join("");
		expect(reconstructed).toBe("let me think about this");
	});

	it("streams tool call deltas", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};

		harness = createHarness({
			responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, "done"],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("use tool");

		const updates = harness.eventsOfType("message_update");
		const toolcallStarts = updates.filter((e) => e.assistantMessageEvent.type === "toolcall_start");
		const toolcallDeltas = updates.filter((e) => e.assistantMessageEvent.type === "toolcall_delta");
		const toolcallEnds = updates.filter((e) => e.assistantMessageEvent.type === "toolcall_end");

		expect(toolcallStarts).toHaveLength(1);
		expect(toolcallDeltas.length).toBeGreaterThan(0);
		expect(toolcallEnds).toHaveLength(1);
	});

	it("streams thinking then text then tool call in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};

		harness = createHarness({
			responses: [
				{
					thinking: "hmm",
					text: "I will call a tool",
					toolCalls: [{ name: "echo", args: { text: "x" } }],
				},
				"final",
			],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("do it");

		const updates = harness.eventsOfType("message_update");
		const streamTypes = updates.map((e) => e.assistantMessageEvent.type);

		// Thinking events should come before text events, text before toolcall
		const firstThinking = streamTypes.indexOf("thinking_start");
		const firstText = streamTypes.indexOf("text_start");
		const firstToolcall = streamTypes.indexOf("toolcall_start");

		expect(firstThinking).toBeLessThan(firstText);
		expect(firstText).toBeLessThan(firstToolcall);
	});

	it("loads inline extension factories and disambiguates duplicate commands", async () => {
		const calls: string[] = [];

		harness = await createHarnessWithExtensions({
			extensionFactories: [
				{
					path: "<alpha>",
					factory: (pi) => {
						pi.registerCommand("shared-cmd", {
							description: "Alpha command",
							handler: async (args) => {
								calls.push(`alpha:${args}`);
							},
						});
					},
				},
				{
					path: "<beta>",
					factory: (pi) => {
						pi.registerCommand("shared-cmd", {
							description: "Beta command",
							handler: async (args) => {
								calls.push(`beta:${args}`);
							},
						});
					},
				},
			],
		});

		const runner = harness.session.extensionRunner;
		expect(runner).toBeDefined();

		const commands = runner!.getRegisteredCommands();
		expect(
			commands.map((command) => ({
				name: command.name,
				invocationName: command.invocationName,
				description: command.description,
				path: command.sourceInfo.path,
			})),
		).toEqual([
			{ name: "shared-cmd", invocationName: "shared-cmd:1", description: "Alpha command", path: "<alpha>" },
			{ name: "shared-cmd", invocationName: "shared-cmd:2", description: "Beta command", path: "<beta>" },
		]);

		await runner!.getCommand("shared-cmd:1")?.handler("first", runner!.createCommandContext());
		await runner!.getCommand("shared-cmd:2")?.handler("second", runner!.createCommandContext());

		expect(calls).toEqual(["alpha:first", "beta:second"]);
	});

	it("executes multi_tool_use.seq_dependent in order", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				{
					path: "<multi-tool-use>",
					factory: (pi) => {
						pi.registerTool({
							name: "multi_tool_use.seq_dependent",
							label: "Seq Dependent",
							description: "Execute dependent tool calls sequentially in one wrapper call.",
							parameters: Type.Object({
								calls: Type.Array(
									Type.Object({
										tool: Type.String(),
										arguments: Type.Record(Type.String(), Type.Unknown()),
									}),
								),
							}),
							execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
								const outputs: string[] = [];
								for (let index = 0; index < params.calls.length; index++) {
									const call = params.calls[index];
									const result = await ctx.runTool(call.tool, call.arguments, {
										toolCallId: `${toolCallId}_${index + 1}`,
										signal,
									});
									outputs.push(JSON.stringify(result.result.content));
									if (result.isError) {
										return {
											content: [{ type: "text", text: `Stopped after tool ${index + 1}` }],
											details: { outputs },
										};
									}
								}
								return { content: [{ type: "text", text: outputs.join("\n") }], details: { outputs } };
							},
						});
					},
				},
			],
			responses: [
				{
					toolCalls: [
						{
							name: "multi_tool_use.seq_dependent",
							args: {
								calls: [
									{ tool: "write", arguments: { path: "ordered.txt", content: "hello" } },
									{ tool: "read", arguments: { path: "ordered.txt" } },
								],
							},
						},
					],
				},
				"done",
			],
		});

		await harness.session.prompt("run dependent tool calls");

		const toolResults = harness
			.eventsOfType("message_end")
			.filter(
				(event): event is typeof event & { message: Extract<(typeof event)["message"], { role: "toolResult" }> } =>
					event.message.role === "toolResult",
			);
		const wrapperResult = toolResults.find((event) => event.message.toolName === "multi_tool_use.seq_dependent");
		expect(wrapperResult).toBeDefined();
		expect(JSON.stringify(wrapperResult?.message.content)).toContain("hello");
	});

	it("emits nested tool execution events for multi_tool_use.seq_dependent", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				{
					path: "<multi-tool-use>",
					factory: (pi) => {
						pi.registerTool({
							name: "multi_tool_use.seq_dependent",
							label: "Seq Dependent",
							description: "Execute dependent tool calls sequentially in one wrapper call.",
							parameters: Type.Object({
								calls: Type.Array(
									Type.Object({
										tool: Type.String(),
										arguments: Type.Record(Type.String(), Type.Unknown()),
									}),
								),
							}),
							execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
								for (let index = 0; index < params.calls.length; index++) {
									const call = params.calls[index];
									const result = await ctx.runTool(call.tool, call.arguments, {
										toolCallId: `${toolCallId}_${index + 1}`,
										signal,
									});
									if (result.isError) {
										return {
											content: [{ type: "text", text: `Stopped after tool ${index + 1}` }],
											details: {},
										};
									}
								}
								return { content: [{ type: "text", text: "done" }], details: {} };
							},
						});
					},
				},
			],
			responses: [
				{
					toolCalls: [
						{
							name: "multi_tool_use.seq_dependent",
							args: {
								calls: [
									{ tool: "write", arguments: { path: "ordered.txt", content: "hello" } },
									{ tool: "read", arguments: { path: "ordered.txt" } },
								],
							},
						},
					],
				},
				"done",
			],
		});

		await harness.session.prompt("run dependent tool calls");

		const nestedStarts = harness
			.eventsOfType("tool_execution_start")
			.filter((event) => event.toolName !== "multi_tool_use.seq_dependent");
		const nestedEnds = harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName !== "multi_tool_use.seq_dependent");

		expect(nestedStarts.map((event) => event.toolName)).toEqual(["write", "read"]);
		expect(nestedEnds.map((event) => ({ toolName: event.toolName, isError: event.isError }))).toEqual([
			{ toolName: "write", isError: false },
			{ toolName: "read", isError: false },
		]);
	});

	it("stops multi_tool_use.seq_dependent on first error", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				{
					path: "<multi-tool-use>",
					factory: (pi) => {
						pi.registerTool({
							name: "multi_tool_use.seq_dependent",
							label: "Seq Dependent",
							description: "Execute dependent tool calls sequentially in one wrapper call.",
							parameters: Type.Object({
								calls: Type.Array(
									Type.Object({
										tool: Type.String(),
										arguments: Type.Record(Type.String(), Type.Unknown()),
									}),
								),
							}),
							execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
								for (let index = 0; index < params.calls.length; index++) {
									const call = params.calls[index];
									const result = await ctx.runTool(call.tool, call.arguments, {
										toolCallId: `${toolCallId}_${index + 1}`,
										signal,
									});
									if (result.isError) {
										return {
											content: [{ type: "text", text: `Stopped after tool ${index + 1}` }],
											details: {},
										};
									}
								}
								return { content: [{ type: "text", text: "done" }], details: {} };
							},
						});
					},
				},
			],
			responses: [
				{
					toolCalls: [
						{
							name: "multi_tool_use.seq_dependent",
							args: {
								calls: [
									{ tool: "read", arguments: { path: "missing.txt" } },
									{ tool: "write", arguments: { path: "should-not-exist.txt", content: "later" } },
								],
							},
						},
					],
				},
				"done",
			],
		});

		await harness.session.prompt("run dependent tool calls with failure");

		const toolResults = harness
			.eventsOfType("message_end")
			.filter(
				(event): event is typeof event & { message: Extract<(typeof event)["message"], { role: "toolResult" }> } =>
					event.message.role === "toolResult",
			);
		const wrapperResult = toolResults.find((event) => event.message.toolName === "multi_tool_use.seq_dependent");
		expect(wrapperResult?.message.isError).toBe(false);
		expect(JSON.stringify(wrapperResult?.message.content)).toContain("Stopped after tool 1");
		expect(existsSync(join(harness.tempDir, "should-not-exist.txt"))).toBe(false);
	});

	it("session persistence works", async () => {
		harness = createHarness({ responses: ["persisted"] });

		await harness.session.prompt("hi");

		const entries = harness.sessionManager.getEntries();
		const messageEntries = entries.filter((e) => e.type === "message");
		expect(messageEntries.length).toBeGreaterThanOrEqual(2); // user + assistant
	});
});
