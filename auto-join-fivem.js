require("dotenv").config();

const fs = require("node:fs/promises");

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
		if (clientOneStored === clientTwoStored) {
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
	const { error, stdout } = await exec("tasklist /fo csv");

	if (error) {
		throw error;
	}

	return Papa.parse(stdout).data
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

		await wait(1000);
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

		await wait(1000);
	}
}

// -1 -> unknown (server not responding)
// 0 -> not connected
// 1 -> connected (loading)
// 2 -> connected (joined)
async function getClientJoinState(pLicenseIdentifier) {
	const response = await axios.get(`${process.env.SERVER_ENDPOINT}/op-framework/connections.json`, {
		timeout: 5000
	})
		.catch(pError => {
			console.error(pError);
		});

	if (response?.status !== 200) {
		return -1;
	}

	const { statusCode, data } = response.data;

	if (statusCode !== 200) {
		return -1;
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

	const temporaryScriptPath = path.join("temp", getRandomString(20) + ".ahk");

	await fs.writeFile(temporaryScriptPath, connectScript);

	const autoHotkeyPath = path.join("C:", "Program Files", "AutoHotkey", "v2", "AutoHotkey.exe");

	await exec(`"${autoHotkeyPath}" ${temporaryScriptPath}`);

	await fs.rm(temporaryScriptPath);

	const files = await fs.readdir("temp");

	if (files.length === 0) {
		await fs.rm("temp", {
			recursive: true
		});
	}
}

async function openDevtools(pClientName, pMenuTask) {
	const oldTasklist = await getTasklist();

	await executeAHK("devtools.ahk", {
		"PROCESS_ID": pMenuTask.processId
	});

	let devtoolsTask;

	while (true) {
		let tasklist = await getTasklist();

		tasklist = tasklist.filter(pTask => {
			return !oldTasklist.find(pOldTask => {
				return pTask.processId === pOldTask.processId;
			});
		});

		const devtoolsTaskProcessName = pClientName === "cl_2" ? "FiveM_cl2_ChromeBrowser" : "FiveM_ChromeBrowser";

		devtoolsTask = tasklist.find(pTask => pTask.processName === devtoolsTaskProcessName);

		if (devtoolsTask) {
			break;
		}

		await wait(0);
	}

	return devtoolsTask;
}

async function collectGarbage(pClientProcessId, pClientName) {
	console.log(`[${pClientName}] Starting garbage collection.`);

	await executeAHK("collectgarbage.ahk", {
		"PROCESS_ID": pClientProcessId
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

		const menuTaskProcessName = pClientName === "cl_2" ? "FiveM_cl2_b2699_GTAProcess.exe" : "FiveM_b2699_GTAProcess.exe";

		clientTask = tasklist.find(pTask => pTask.processName === "FiveM.exe");
		menuTask = tasklist.find(pTask => pTask.processName === menuTaskProcessName);

		if (clientTask && menuTask) {
			break;
		}

		await wait(0);
	}

	console.log(`[${pClientName}] Client task & menu task detected.`);

	const clientJoinState = await getClientJoinState(pClient.licenseIdentifier);

	if (clientJoinState > 0) {
		console.log(`[${pClientName}] Old client session is lingering on the server, waiting for it to go away.`);

		while (await getClientJoinState(pClient.licenseIdentifier) > 0) {
			await wait(1000);
		}

		console.log(`[${pClientName}] Old client session is now gone.`);
	}

	await executeAHK("f8connect.ahk", {
		"PROCESS_ID": menuTask.processId,
		"SERVER_IP": process.env.SERVER_IP
	});

	console.log(`[${pClientName}] Completed client connect sequence.`);

	const connectTimer = Date.now() + (5 * 60 * 1000);

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

		await wait(1000);
	}

	console.log(`[${pClientName}] Client has connected to the server.`);

	while (await getClientJoinState(pClient.licenseIdentifier) === 1) {
		await wait(1000);
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

	const devtoolsTask = await openDevtools(pClientName, menuTask);

	console.log(`[${pClientName}] Opened & found devtools task.`);

	pClient.devtools.processId = devtoolsTask.processId;

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
				processId: false,
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
				processId: false,
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

					pClient.devtools.processId = false;
					pClient.devtools.garbageTimer = false;
				}
			}
		});

		let occupied = clients.some(pClient => pClient.launching);

		clients.forEach((pClient, pClientIndex) => {
			if (occupied) {
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

			const devtoolsProcessId = client.devtools.processId;

			if (!devtoolsProcessId) {
				continue;
			}

			const devtoolsAlive = tasklist.some(pTask => pTask.processId === devtoolsProcessId);

			if (!devtoolsAlive) {
				continue;
			}

			if (!client.garbageTimer) {
				client.garbageTimer = Date.now() + (2 * 60 * 1000);
			}

			if (Date.now() < client.garbageTimer) {
				continue;
			}

			occupied = true;

			await collectGarbage(client.menuProcessId, clientName);

			// NOTE: collect garbage every 2 minutes
			client.garbageTimer += (2 * 60 * 1000);
		}

		for (let clientIndex in clients) {
			const client = clients[clientIndex];

			const clientName = `cl_${Number(clientIndex) + 1}`;

			if (occupied) {
				continue;
			}

			const uptime = Date.now() - client.uptimeTimer;

			let acceptableUptime = 2 * 60 * 60 * 1000;

			// NOTE: To not restart at the exact same times, add another 15 minutes of acceptable uptime to cl_2
			if (clientName === "cl_2") {
				acceptableUptime += (15 * 60 * 1000);
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

		await wait(0);
	}
})();
