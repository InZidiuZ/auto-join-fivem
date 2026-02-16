import fs from "fs/promises";
import path from "path";
import util from "util";
import crypto from "crypto";
import childProcess from "child_process";

import pIteration from "p-iteration";
import axios from "axios";
import Papa from "papaparse";
import express from "express";

import config from "./config.ts";

interface Player {
	licenseIdentifier: string;
	joined: boolean;
}

interface Client {
	licenseIdentifier: string;
	processId: number | null;
	menuProcessId: number | null;
	launching: boolean;
	uptimeTimer: number | null;
	devtools: {
		garbageTimer: number | null;
	}
}

const exec = util.promisify(childProcess.exec);

function wait(pMilliseconds: number) {
	return new Promise(pResolve => setTimeout(pResolve, pMilliseconds));
}

async function setDigitalEntitlements(pClientName?: string) {
	const clientPath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements");

	const clientOnePath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements-cl_1");
	const clientTwoPath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements-cl_2");

	await fs.rm(clientPath, { recursive: true })
		.catch(pError => {
			if (pError.code === "ENOENT") {
				return;
			}

			console.error(pError);
		});

	switch (pClientName) {
		case "cl_1":
			await fs.cp(clientOnePath, clientPath, { recursive: true });

			break;
		case "cl_2":
			await fs.cp(clientTwoPath, clientPath, { recursive: true });

			break;
	}
}

async function getTasklist() {
	let tasklistStdout;

	while (true) {
		const output = await exec("tasklist /fo csv")
			.catch(pError => {
				console.error("Failed to get tasklist. (1)", pError);
			});

		if (output) {
			const { stderr, stdout } = output;

			if (stderr) {
				console.error("Failed to get tasklist. (2)", stderr);
			} else {
				tasklistStdout = stdout;

				break;
			}
		}

		await wait(1_000);
	}

	return Papa.parse<[ string, string ]>(tasklistStdout).data
		.map((pRow, pRowIndex) => {
			if (pRowIndex === 0) {
				return null;
			}

			return {
				processName: pRow[0],
				processId: Number(pRow[1])
			}
		})
		.filter(pRow => pRow !== null);
}

async function closeOldClients() {
	while (true) {
		const tasklist = await getTasklist();

		const hasClients = tasklist.some(pTask => {
			return pTask.processName.startsWith("FiveM.exe");
		});

		if (!hasClients) {
			break;
		}

		await pIteration.forEach(tasklist, async pTask => {
			if (pTask.processName === "FiveM.exe") {
				await exec(`taskkill /F /pid ${pTask.processId}`)
					.catch(pError => {});
			}
		});

		await wait(1_000);
	}
}

async function kill(pProcessId: number) {
	while (true) {
		const tasklist = await getTasklist();

		const stillAlive = tasklist.some(pTask => pTask.processId === pProcessId);

		if (!stillAlive) {
			break;
		}

		await exec(`taskkill /F /pid ${pProcessId}`)
			.catch(pError => {});

		await wait(1_000);
	}
}

// -1 -> unknown (server not responding) (will never return this, since it keeps trying infinitly for a good response)
// 0 -> not connected
// 1 -> connected (loading)
// 2 -> connected (joined)
async function getClientJoinState(pLicenseIdentifier: string) {
	while (true) {
		const response = await axios.get<{
			statusCode: number;
			data: Player[]
		}>(`${config.SERVER_ENDPOINT}/op-framework/connections.json`, {
			timeout: 5_000
		})
			.catch(pError => {
				if (pError.code === "ECONNABORTED") {
					return;
				}

				if (pError.code === "ERR_BAD_RESPONSE") {
					return;
				}

				if (pError.code === "ECONNREFUSED") {
					return;
				}

				if (pError.code === "ERR_BAD_REQUEST") {
					return;
				}

				if (pError.code === "ECONNRESET") {
					return;
				}

				console.error(pError);
			});

		if (response?.status !== 200) {
			await wait(1_000);

			continue;
		}

		const { statusCode, data } = response.data;

		if (statusCode !== 200) {
			await wait(1_000);

			continue;
		}

		const player = data.find(pPlayer => pPlayer.licenseIdentifier === pLicenseIdentifier);

		if (!player) {
			return 0;
		}

		if (!player.joined) {
			return 1;
		}

		return 2;
	}
}

function getRandomString(pLength: number) {
	return crypto.randomBytes(pLength).toString("hex");
}

async function executeAHK(pFileName: string, pVariables: { [key: string]: string | number} ) {
	await fs.mkdir("temp")
		.catch(pError => {
			if (pError.code === "EEXIST") {
				return;
			}

			console.error(pError);
		});

	let connectScript = await fs.readFile(path.join("scripts", pFileName), {
		encoding: "utf8"
	});

	Object.entries(pVariables).forEach(([pKey, pValue]) => {
		connectScript = connectScript.replaceAll(`process.env.${pKey}`, String(pValue));
	});

	const temporaryScriptPath = path.resolve(path.join("temp", getRandomString(20) + ".ahk"));

	await fs.writeFile(temporaryScriptPath, connectScript);

	const autoHotkeyPath = path.join("C:", "Program Files", "AutoHotkey", "v2", "AutoHotkey.exe");

	const child = childProcess.spawn(autoHotkeyPath, [ temporaryScriptPath ]);

	let exited = false;

	const timeout = setTimeout(() => {
		console.log(`[ahk] Script took too long. Killing child now...`);

		child.kill();

		exited = true;
	}, 30_000);

	child.on("exit", (pCode, pSignal) => {
		clearTimeout(timeout);

		if (pSignal) {
			console.log(`[ahk] child killed due to timeout.`);
		} else {
			console.log(`[ahk] Child exited with code ${pCode}.`);
		}

		exited = true;
	});

	child.on("error", pError => {
		clearTimeout(timeout);

		console.error(`[ahk] Failed to start process: ${pError.message}.`);

		exited = true;
	});

	while (!exited) {
		await wait(1_000);
	}

	await fs.rm(temporaryScriptPath);
}

async function openDevtools(pClientName: string, pMenuTaskProcessId: number) {
	const oldTasklist = await getTasklist();

	await executeAHK("devtools.ahk", {
		"PROCESS_ID": pMenuTaskProcessId
	});

	for (let attempt = 0; attempt < 30; attempt++) {
		let tasklist = await getTasklist();

		tasklist = tasklist.filter(pTask => {
			return !oldTasklist.find(pOldTask => {
				return pTask.processId === pOldTask.processId;
			});
		});

		const devtoolsTaskProcessName = pClientName === "cl_2" ? "FiveM_cl2_ChromeBrowser" : "FiveM_ChromeBrowser";

		const devtoolsTask = tasklist.find(pTask => pTask.processName === devtoolsTaskProcessName);

		if (devtoolsTask) {
			return true;
		}

		await wait(1_000);
	}

	return false;
}

const processNames = new Map();

async function collectGarbage(pClientName: string) {
	console.log(`[${pClientName}] Starting garbage collection.`);

	const processName = processNames.get(pClientName);

	await executeAHK("collectgarbage.ahk", {
		"PROCESS_NAME": processName
	});

	console.log(`[${pClientName}] Completed garbage collection.`);
}

// "FiveM_bXXXX_GTAProcess.exe" -> "FiveM_GTAProcess.exe"
function removeBuildFromProcessName(pProcessName: string) {
	return pProcessName.replace(/_b\d+/, "");
}

async function launchClient(pClient: Client, pClientName: string) {
	console.log(`[${pClientName}] Launching.`);

	pClient.launching = true;

	// NOTE: might not be necessary after all
	/*
	const rosIdPath = path.join("C:", "Users", "root", "AppData", "Roaming", "CitizenFX", pClientName === "cl_2" ? "ros_idCL2.dat" : "ros_id.dat");

	// NOTE: deleting (and then regenerating) this fixes cl2 breaking
	await fs.rm(rosIdPath)
		.catch(pError => {
			if (pError.code === "ENOENT") {
				return;
			}

			console.error(pError);
		});
		*/

	await setDigitalEntitlements(pClientName);

	console.log(`[${pClientName}] Set DigitalEntitlements.`);

	const oldTasklist = await getTasklist();

	const launchParameters = [
		"-pure_1"
	];

	if (pClientName === "cl_2") {
		launchParameters.push("-cl2");
	}

	exec(`FiveM.exe ${launchParameters.join(" ")}`, {
		cwd: path.join("C:", "Users", "root", "AppData", "Local", "FiveM")
	})
		.catch(pError => {});

	console.log(`[${pClientName}] Launched FiveM.`);

	let clientTask;
	let menuTask;

	const launchTimer = Date.now() + (30 * 1_000);

	while (true) {
		let tasklist = await getTasklist();

		tasklist = tasklist.filter(pTask => {
			return !oldTasklist.find(pOldTask => {
				return pTask.processId === pOldTask.processId;
			});
		});

		const menuTaskProcessName = pClientName === "cl_2"
			? `FiveM_cl2_GTAProcess.exe`
			: `FiveM_GTAProcess.exe`;

		clientTask = tasklist.find(pTask => pTask.processName === "FiveM.exe");
		menuTask = tasklist.find(pTask => removeBuildFromProcessName(pTask.processName) === menuTaskProcessName);

		if (clientTask && menuTask) {
			processNames.set(pClientName, menuTask.processName);

			console.log(`[${pClientName}] Set process name as ${menuTask.processName}.`);

			break;
		}

		if (Date.now() >= launchTimer) {
			console.log(`[${pClientName}] Failed launching, took too long to launch process.`);

			pClient.launching = false;

			return;
		}

		await wait(1_000);
	}

	console.log(`[${pClientName}] Client task & menu task detected.`);

	const clientJoinState = await getClientJoinState(pClient.licenseIdentifier);

	if (clientJoinState > 0) {
		console.log(`[${pClientName}] Old client session is lingering on the server, waiting for it to go away.`);

		while (await getClientJoinState(pClient.licenseIdentifier) > 0) {
			await wait(1_000);
		}

		console.log(`[${pClientName}] Old client session is now gone.`);
	}

	await executeAHK("f8connect.ahk", {
		"PROCESS_ID": menuTask.processId,
		"SERVER_IP": config.SERVER_IP
	});

	console.log(`[${pClientName}] Completed client connect sequence.`);

	const connectTimer = Date.now() + (5 * 60 * 1_000);

	while (true) {
		const clientJoinState = await getClientJoinState(pClient.licenseIdentifier);

		if (clientJoinState > 0) {
			break;
		}

		if (Date.now() >= connectTimer) {
			console.log(`[${pClientName}] Failed launching, took too long to connect.`);

			await kill(clientTask.processId);

			await wait(30_000);

			console.log(`[${pClientName}] Finished exit process.`);

			pClient.launching = false;

			return;
		}

		await wait(1_000);
	}

	console.log(`[${pClientName}] Client has connected to the server.`);

	while (await getClientJoinState(pClient.licenseIdentifier) === 1) {
		await wait(1_000);
	}

	if (await getClientJoinState(pClient.licenseIdentifier) !== 2) {
		console.log(`[${pClientName}] Failed loading in.`);

		await kill(clientTask.processId);

		await wait(30_000);

		console.log(`[${pClientName}] Finished exit process.`);

		pClient.launching = false;

		return;
	}

	console.log(`[${pClientName}] Client has loaded into the server.`);

	if (config.IS_SPECTATOR) {
		await executeAHK("f8close.ahk", {
			"PROCESS_ID": menuTask.processId
		});
	} else {
		const openedDevtools = await openDevtools(pClientName, menuTask.processId);

		if (!openedDevtools) {
			console.log(`[${pClientName}] Failed to open devtools.`);

			await kill(clientTask.processId);

			await wait(30_000);

			console.log(`[${pClientName}] Finished exit process.`);

			pClient.launching = false;

			return;
		}
	}

	console.log(`[${pClientName}] Opened & found devtools task.`);

	await setDigitalEntitlements();

	pClient.processId = clientTask.processId;
	pClient.menuProcessId = menuTask.processId;
	pClient.uptimeTimer = Date.now();

	pClient.launching = false;

	console.log(`[${pClientName}] Finished launching.`);
}

const licenseIdentifiers = config.LICENSE_IDENTIFIERS.split(" ");

const clients: Client[] = [
	{
		licenseIdentifier: licenseIdentifiers[0],
		processId: null,
		menuProcessId: null,
		launching: false,
		uptimeTimer: null,
		devtools: {
			garbageTimer: null
		}
	},

	{
		licenseIdentifier: licenseIdentifiers[1],
		processId: null,
		menuProcessId: null,
		launching: false,
		uptimeTimer: null,
		devtools: {
			garbageTimer: null
		}
	}
];

(async () => {
	await fs.rm("temp", {
		recursive: true
	})
		.catch(pError => {
			if (pError.code === "ENOENT") {
				return;
			}

			console.error(pError);
		});

	await closeOldClients();

	await setDigitalEntitlements();

	while (true) {
		const tasklist = await getTasklist();

		clients.forEach((pClient, pClientIndex) => {
			if (pClient.launching) {
				return;
			}

			if (pClient.processId) {
				const stillAlive = tasklist.find(pTask => pTask.processId === pClient.processId);

				if (!stillAlive) {
					console.log(`[cl_${pClientIndex + 1}] Process ID is gone, deleting.`);

					pClient.processId = null;
					pClient.uptimeTimer = null;
					pClient.menuProcessId = null;

					pClient.devtools.garbageTimer = null;
				}
			}
		});

		let occupied = clients.some(pClient => pClient.launching);

		clients.forEach((pClient, pClientIndex) => {
			if (occupied) {
				return;
			}

			if (!pClient.licenseIdentifier) {
				return;
			}

			if (!pClient.processId) {
				occupied = true;

				launchClient(pClient, `cl_${pClientIndex + 1}`);
			}
		});

		for (let clientIndex in clients) {
			if (config.IS_SPECTATOR) {
				continue;
			}

			const client = clients[clientIndex];

			const clientName = `cl_${Number(clientIndex) + 1}`;

			if (occupied) {
				continue;
			}

			if (!client.licenseIdentifier) {
				continue;
			}

			if (!client.devtools.garbageTimer) {
				client.devtools.garbageTimer = Date.now() + (2 * 60 * 1_000);
			}

			if (Date.now() < client.devtools.garbageTimer) {
				continue;
			}

			occupied = true;

			await collectGarbage(clientName);

			// NOTE: collect garbage every 2 minutes
			client.devtools.garbageTimer += (2 * 60 * 1_000);
		}

		for (let clientIndex in clients) {
			if (config.IS_SPECTATOR) {
				continue;
			}

			const client = clients[clientIndex];

			const clientName = `cl_${Number(clientIndex) + 1}`;

			if (occupied) {
				continue;
			}

			if (!client.licenseIdentifier) {
				continue;
			}

			if (!client.uptimeTimer) {
				continue;
			}

			const uptime = Date.now() - client.uptimeTimer;

			let acceptableUptime = 4 * 60 * 60 * 1_000;

			// NOTE: To not restart at the exact same times, add another 15 minutes of acceptable uptime to cl_2
			if (clientName === "cl_2") {
				acceptableUptime += (15 * 60 * 1_000);
			}

			if (uptime > acceptableUptime) {
				occupied = true;

				console.log(`[${clientName}] Client has been up for longer than the acceptable time. Killing & restarting.`);

				// NOTE: wait for both of these to be killed & dead for proper exit
				if (client.processId) await kill(client.processId);
				if (client.menuProcessId) await kill(client.menuProcessId);
			}
		}

		for (let clientIndex in clients) {
			const client = clients[clientIndex];

			const clientName = `cl_${Number(clientIndex) + 1}`;

			if (occupied) {
				continue;
			}

			if (!client.processId) {
				continue;
			}

			const clientJoinState = await getClientJoinState(client.licenseIdentifier);

			if (clientJoinState === 0) {
				occupied = true;

				console.log(`[${clientName}] Client is not on the server but the client is active. Killing & restarting.`);

				// NOTE: wait for both of these to be killed & dead for proper exit
				if (client.processId) await kill(client.processId);
				if (client.menuProcessId) await kill(client.menuProcessId);
			}
		}

		await fs.mkdir(path.join("_logs"), {
			recursive: true
		});

		await fs.writeFile(path.join("_logs", "clients.json"), JSON.stringify(clients, null, 2))
			.catch(pError => {
				console.error(pError);
			});

		await wait(1_000);
	}
})();

const app = express();

app.get("/status", (pRequest, pResponse) => {
	pResponse.status(200).json({
		clients: clients
	});
});

app.listen(config.PORT, pError => {
	if (pError) {
		throw pError;
	}

	console.log(`[express] Listening on port ${config.PORT}!`);
});
