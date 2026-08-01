import { stringsTool, fileTool } from "../src/index.ts";

async function main() {
	const r1 = await fileTool.execute("test1", { path: "/bin/ls" });
	console.log("filetype result:", r1.content[0].text);

	const r2 = await stringsTool.execute("test2", { path: "/bin/ls", minLength: 10 });
	const lines = r2.content[0].text.split("\n").filter(Boolean);
	console.log("strings count:", r2.details?.count);
	console.log("first 5 strings:", lines.slice(0, 5).join("\n"));
}

main();
