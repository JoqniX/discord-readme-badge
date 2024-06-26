require("dotenv").config();
const Card = require("../src/Card");
const sharp = require("sharp");
const { Client, GatewayIntentBits, DiscordAPIError } = require("discord.js");

const allowlistGames = require("../src/allowlistGames");

const truncate = (input) =>
	input.length > 32 ? `${input.substring(0, 32)}...` : input;

const encodeHTML = (input) => {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
};

const processText = (input) => {
	return encodeHTML(truncate(input));
};

const getImageBufferFromUrl = async (imageUrl) => {
	const response = await fetch(imageUrl);

	if (!response.ok) {
		throw new Error(`unexpected response ${response.statusText}`);
	}

	// https://stackoverflow.com/a/76596000
	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
};

const resizedBufferFromImageBuffer = async (imageBuffer) => {
	// https://github.com/lovell/sharp/issues/1337#issuecomment-412880172
	return await sharp(imageBuffer).resize(128, 128).png().toBuffer();
};

const getBase64FromUrl = async (imageUrl) => {
	const imageBuffer = await getImageBufferFromUrl(imageUrl);
	const sharpBuffer = await resizedBufferFromImageBuffer(imageBuffer);
	return sharpBuffer.toString("base64");
};

/**
 * @typedef {Object} Presence
 * @property {string} username
 * @property {string} pfpImage
 * @property {string} status
 * @property {string} gameType
 * @property {string} game
 * @property {string} details
 * @property {string} detailsImage
 * @property {string} state
 * @property {number} height
 *
 * @param {import("discord.js").GuildMember} member
 */
async function parsePresence(member) {
	const username = processText(member.user.username);

	let pfpImage = false;
	try {
		const pfpImageUrl = member.displayAvatarURL({
			format: "png",
			dynamic: false,
			size: 128,
		});

		const pfpImageBase64 = await getBase64FromUrl(pfpImageUrl);
		pfpImage = `data:image/png;base64,${pfpImageBase64}`;
	} catch (error) {
		if (error?.code !== 404 && error?.code !== "ETIMEDOUT") {
			console.error(error);
		}
	}

	// console.log(member.presence);

	if (!member.presence) {
		return {
			username,
			pfpImage,
			status: "offline",
			gameType: "Offline",
			game: "",
			details: "",
			detailsImage: false,
			state: "",
			height: 97,
		};
	}

	const statuses = member.presence.clientStatus;
	if (!statuses) {
		return {
			username,
			pfpImage,
			status: "offline",
			gameType: "Offline",
			game: "",
			details: "",
			detailsImage: false,
			state: "",
			height: 97,
		};
	}
	const status = statuses.desktop || statuses.mobile || statuses.web;

	const playingRichGame = member.presence.activities
		.reverse()
		.find(
			(e) =>
				allowlistGames.includes(e.name.toLowerCase()) && (e.details || e.state),
		);
	const playingGame = member.presence.activities
		.reverse()
		.find(
			(e) =>
				allowlistGames.includes(e.name.toLowerCase()) && !e.details && !e.state,
		);
	const spotifyGame = member.presence.activities.find(
		(e) => e.type === "LISTENING" && e.name === "Spotify",
	);

	const gameObject = playingRichGame || playingGame || spotifyGame;

	if (!gameObject) {
		return {
			username,
			pfpImage,
			status,
			gameType: "",
			game: "",
			details: "",
			detailsImage: false,
			state: "",
			height: 97,
		};
	}

	// console.log(gameObject);

	const game = processText(gameObject.name);
	let gameType = "Playing";

	if (game === "Spotify") gameType = "Listening to";

	if (!gameObject.details && !gameObject.state) {
		return {
			username,
			pfpImage,
			status,
			gameType,
			game,
			details: "",
			detailsImage: false,
			state: "",
			height: 97,
		};
	}

	const details = gameObject.details ? processText(gameObject.details) : "";

	let detailsImageUrl = false;
	let detailsImage = false;
	if (gameObject.assets?.largeImage) {
		// "mp:" prefixed assets don't use keys and will use different image url formatting
		// as according to https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-asset-image
		if (gameObject.assets.largeImage.startsWith("mp:")) {
			detailsImageUrl = `https://media.discordapp.net/${gameObject.assets.largeImage.substring(
				3,
			)}`;
		} else {
			detailsImageUrl = `https://cdn.discordapp.com/app-assets/${gameObject.applicationId}/${gameObject.assets.largeImage}.png`;

			if (game === "Spotify")
				detailsImageUrl = `https://i.scdn.co/image/${gameObject.assets.largeImage.replace(
					"spotify:",
					"",
				)}`;
		}

		try {
			const detailsImageBase64 = await getBase64FromUrl(detailsImageUrl);

			detailsImage = `data:image/png;base64,${detailsImageBase64}`;
		} catch (error) {
			if (error?.code !== 404 && error?.code !== "ETIMEDOUT") {
				console.error(error);
			}
		}
	}

	const state = gameObject.state ? processText(gameObject.state) : "";

	return {
		username,
		pfpImage,
		status,
		game,
		gameType,
		details,
		detailsImage,
		state,
		height: 187,
	};
}

module.exports = async (req, res) => {
	res.setHeader("Content-Type", "image/svg+xml");
	res.setHeader("Cache-Control", "public, max-age=30");

	const { id } = req.query;

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildPresences,
			GatewayIntentBits.GuildMembers,
		],
	});

	await client.login(process.env.DISCORD_BOT_TOKEN);

	const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);

	let card;

	try {
		const member = await guild.members.fetch({
			user: id,
			cache: false,
			force: true,
		});

		// console.log("GOT MEMBER", member);
		// console.log("MEMBER PRESENCE", member.presence);

		const cardContent = await parsePresence(member);
		card = new Card(cardContent);
	} catch (error) {
		if (error?.code !== 10013) {
			console.error(error);
		}

		if (error instanceof DiscordAPIError) {
			if (error.code === 10013) {
				card = new Card({
					username: "Error",
					pfpImage:
						"https://cdn.discordapp.com/icons/839432085856583730/59d186ba87f3d08917893a1273dce0ae.webp?size=1280",
					status: "dnd",
					game: "Zyplos/discord-readme-badge",
					gameType: "Check",
					details: "You don't seem to be in the server.",
					detailsImage:
						"https://sparkcdnwus2.azureedge.net/sparkimageassets/XPDC2RH70K22MN-08afd558-a61c-4a63-9171-d3f199738e9f",
					state: "Did you use the correct user ID?",
					height: 187,
				});
			} else {
				card = new Card({
					username: "Error",
					pfpImage:
						"https://cdn.discordapp.com/icons/839432085856583730/59d186ba87f3d08917893a1273dce0ae.webp?size=1280",
					status: "dnd",
					game: "Zyplos/discord-readme-badge",
					gameType: "Check",
					details: "Sorry, an error occured!",
					detailsImage:
						"https://sparkcdnwus2.azureedge.net/sparkimageassets/XPDC2RH70K22MN-08afd558-a61c-4a63-9171-d3f199738e9f",
					state: "Are you in the server? Correct ID?",
					height: 187,
				});
			}
		} else {
			card = new Card({
				username: "Error",
				pfpImage:
					"https://cdn.discordapp.com/icons/839432085856583730/59d186ba87f3d08917893a1273dce0ae.webp?size=1280",
				status: "dnd",
				game: "Zyplos/discord-readme-badge",
				gameType: "Report to",
				details: "Sorry, an unexpected error occured!",
				detailsImage:
					"https://sparkcdnwus2.azureedge.net/sparkimageassets/XPDC2RH70K22MN-08afd558-a61c-4a63-9171-d3f199738e9f",
				state: "Please open in an issue.",
				height: 187,
			});
		}
	}

	await client.destroy();

	return res.send(card.render());
};
