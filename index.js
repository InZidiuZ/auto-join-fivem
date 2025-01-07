require("dotenv").config();

const fs = require("fs/promises");

const path = require("path");
const util = require("util");
const crypto = require("crypto");

const childProcess = require("child_process");

const exec = util.promisify(childProcess.exec);

const { forEach } = require("p-iteration");

const axios = require("axios");

const Papa = require("papaparse");

function wait(pMilliseconds) {
	return new Promise(pResolve => setTimeout(pResolve, pMilliseconds));
}

async function setDigitalEntitlements(pClientName) {
	const clientPath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements");

	const clientOnePath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements-cl_1");
	const clientTwoPath = path.join("C:", "Users", "root", "AppData", "Local", "DigitalEntitlements-cl_2");

	let clientStored = !!(await fs.stat(clientPath).catch(pError => {}));

	// NOTE: sometimes an empty 'DigitalEntitlements' are left behind, not sure why
	if (clientStored) {
		const files = await fs.readdir(clientPath);

		if (files.length === 0) {
			await fs.rm(clientPath, {
				recursive: true
			});

			clientStored = false;

			console.log("[DigitalEntitlements] Deleting empty folder.");
		}
	}

	const clientOneStored = !!(await fs.stat(clientOnePath).catch(pError => {}));
	const clientTwoStored = !!(await fs.stat(clientTwoPath).catch(pError => {}));

	if (clientStored) {
		if (clientOneStored && clientTwoStored) {
			throw "Something has gone wrong with DigitalEntitlements handling.";
		}

		if (!clientOneStored) {
			await fs.rename(clientPath, clientOnePath);
		} else {
			await fs.rename(clientPath, clientTwoPath);
		}
	}

	switch (pClientName) {
		case "cl_1":
			await fs.rename(clientOnePath, clientPath);

			break;
		case "cl_2":
			await fs.rename(clientTwoPath, clientPath);

			break;
	}
}

async function getTasklist() {
	let tasklistStdout;

	// never give up!!
	while (true) {
		const output = await exec("tasklist /fo csv")
			.catch(pError => {
				console.error("Failed to get tasklist. (1)", pError);
			});

		if (output) {
			const { error, stdout } = output;

			if (error) {
				console.error("Failed to get tasklist. (2)", error);
			} else {
				tasklistStdout = stdout;

				break;
			}
		}

		await wait(1_000);
	}

	return Papa.parse(tasklistStdout).data
		.map((pRow, pRowIndex) => {
			if (pRowIndex === 0) {
				return null;
			}

			return {
				processName: pRow[0],
				processId: Number(pRow[1])
			}
		})
		.filter(pRow => pRow);
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

		await forEach(tasklist, async pTask => {
			if (pTask.processName === "FiveM.exe") {
				await exec(`taskkill /F /pid ${pTask.processId}`)
					.catch(pError => {});
			}
		});

		await wait(1_000);
	}
}

async function kill(pProcessId) {
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
async function getClientJoinState(pLicenseIdentifier) {
	while (true) {
		const response = await axios.get(`${process.env.SERVER_ENDPOINT}/op-framework/connections.json`, {
			timeout: 5000
		})
			.catch(pError => {
				if (pError.code === "ECONNABORTED" || pError.code === "ERR_BAD_RESPONSE" || pError.code === "ECONNREFUSED" || pError.code === "ERR_BAD_REQUEST" || pError.code === "ECONNRESET") {
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

function getRandomString(pLength) {
	return crypto.randomBytes(pLength).toString("hex");
}

async function executeAHK(pFileName, pVariables) {
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
		connectScript = connectScript.replaceAll(`process.env.${pKey}`, pValue);
	});

	const temporaryScriptPath = path.join(path.resolve(__dirname), "temp", getRandomString(20) + ".ahk");

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

async function openDevtools(pClientName, pMenuTask) {
	const oldTasklist = await getTasklist();

	await executeAHK("devtools.ahk", {
		"PROCESS_ID": pMenuTask.processId
	});

	while (true) {
		let tasklist = await getTasklist();

		tasklist = tasklist.filter(pTask => {
			return !oldTasklist.find(pOldTask => {
				return pTask.processId === pOldTask.processId;
			});
		});

		const devtoolsTaskProcessName = pClientName === "cl_2" ? "FiveM_cl2_ChromeBrowser" : "FiveM_ChromeBrowser";

		const devtoolsTask = tasklist.find(pTask => pTask.processName === devtoolsTaskProcessName);

		if (devtoolsTask) {
			break;
		}

		await wait(1_000);
	}
}

async function collectGarbage(pClientName) {
	console.log(`[${pClientName}] Starting garbage collection.`);

	const processName = pClientName === "cl_2" ? "FiveM_cl2_GTAProcess.exe" : "FiveM_GTAProcess.exe";

	await executeAHK("collectgarbage.ahk", {
		"PROCESS_NAME": processName 
	});

	console.log(`[${pClientName}] Completed garbage collection.`);
}

async function launchClient(pClient, pClientName) {
	console.log(`[${pClientName}] Launching.`);

	pClient.launching = true;

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
		menuTask = tasklist.find(pTask => pTask.processName === menuTaskProcessName);

		if (clientTask && menuTask) {
			break;
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
		"SERVER_IP": process.env.SERVER_IP
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

	await openDevtools(pClientName, menuTask);

	console.log(`[${pClientName}] Opened & found devtools task.`);

	await setDigitalEntitlements(null);

	pClient.processId = clientTask.processId;
	pClient.menuProcessId = menuTask.processId;
	pClient.uptimeTimer = Date.now();

	pClient.launching = false;

	console.log(`[${pClientName}] Finished launching.`);
}

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

	await setDigitalEntitlements(null);

	const licenseIdentifiers = process.env.LICENSE_IDENTIFIERS.split(" ");

	const clients = [
		{
			licenseIdentifier: licenseIdentifiers[0],
			processId: false,
			menuProcessId: false,
			launching: false,
			uptimeTimer: false,
			devtools: {
				garbageTimer: false
			}
		},

		{
			licenseIdentifier: licenseIdentifiers[1],
			processId: false,
			menuProcessId: false,
			launching: false,
			uptimeTimer: false,
			devtools: {
				garbageTimer: false
			}
		}
	];

	while (true) {
		const tasklist = await getTasklist();

		await forEach(tasklist, async pTask => {
			if (!pTask.processName.startsWith("FiveM_")) {
				return;
			}

			if (!pTask.processName.endsWith("_DumpServer")) {
				return;
			}

			// NOTE: DumpServers that exist while the client is active are also killed, but it's honestly not a big deal
			console.log(`[Clients] Killing a DumpServer process (${pTask.processName}).`);

			await kill(pTask.processId);
		});

		clients.forEach((pClient, pClientIndex) => {
			if (pClient.launching) {
				return;
			}

			if (pClient.processId) {
				const stillAlive = tasklist.find(pTask => pTask.processId === pClient.processId);

				if (!stillAlive) {
					console.log(`[cl_${pClientIndex + 1}] Process ID is gone, deleting.`);

					pClient.processId = false;
					pClient.uptimeTimer = false;
					pClient.menuProcessId = false;

					pClient.devtools.garbageTimer = false;
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
			const client = clients[clientIndex];

			const clientName = `cl_${Number(clientIndex) + 1}`;

			if (occupied) {
				continue;
			}

			if (!client.licenseIdentifier) {
				continue;
			}

			const uptime = Date.now() - client.uptimeTimer;

			let acceptableUptime = 2 * 60 * 60 * 1_000;

			// NOTE: To not restart at the exact same times, add another 15 minutes of acceptable uptime to cl_2
			if (clientName === "cl_2") {
				acceptableUptime += (15 * 60 * 1_000);
			}

			if (uptime > acceptableUptime) {
				occupied = true;

				console.log(`[${clientName}] Client has been up for longer than the acceptable time. Killing & restarting.`);

				// NOTE: wait for both of these to be killed & dead for proper exit
				await kill(client.processId);
				await kill(client.menuProcessId);
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
				await kill(client.processId);
				await kill(client.menuProcessId);
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
