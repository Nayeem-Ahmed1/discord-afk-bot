
const { Client, GatewayIntentBits, Events, Partials, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// === Configuration ===
const config = {
  AFK_LOG_CHANNEL_ID: '931126324658065449',
  AFK_VOICE_CHANNEL_ID: '1390942008528605307', 
  AFK_MOVE_DELAY: 1 * 60 * 1000, // 1 minutes delay before moving
  SPAM_SETTINGS: {
    windowMs: 10000,
    warnThreshold: 5,
    timeoutThreshold: 7,
    timeoutDuration: 2 * 60 * 1000,
    exemptRoles: ['Moderator', 'Admin']
  }
};

app.get("/", (req, res) => res.send("AFK Bot is live!"));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel],
});

const afkUsers = new Map();
const spamTracker = new Map();
const timeoutUsers = new Map();
const originalVoiceChannel = new Map();

const commands = [
  new SlashCommandBuilder().setName("afklist").setDescription("Show all users currently AFK (self-deafened)"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check AFK and timeout status of a user")
    .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true))
];

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member;
  if (!member) return;

  const wasDeaf = oldState.selfDeaf;
  const isDeaf = newState.selfDeaf;
  const logChannel = member.guild.channels.cache.get(config.AFK_LOG_CHANNEL_ID);

  if (!wasDeaf && isDeaf) {
    afkUsers.set(member.id, Date.now());

    if (newState.channelId && newState.channelId !== config.AFK_VOICE_CHANNEL_ID) {
      originalVoiceChannel.set(member.id, newState.channelId);
    }

    setTimeout(async () => {
      const stillDeaf = member.voice?.selfDeaf;
      if (stillDeaf && member.voice.channelId !== config.AFK_VOICE_CHANNEL_ID) {
        try {
          await member.voice.setChannel(config.AFK_VOICE_CHANNEL_ID);
        } catch (err) {
          console.warn(`⚠️ Could not move ${member.user.tag} to AFK channel:`, err.code);
        }
      }
    }, config.AFK_MOVE_DELAY);

    try {
      if (!member.nickname?.startsWith('[AFK]')) {
        await member.setNickname(`[AFK] ${member.nickname || member.user.username}`);
      }
      await logChannel?.send(`🔕 ${member.user.tag} is now AFK.`);
    } catch (err) {
      console.warn(`⚠️ Could not change nickname for ${member.user.tag}: ${err.code}`);
      await logChannel?.send(`🔕 ${member.user.tag} is now AFK (couldn't rename).`);
    }
  }

  if (wasDeaf && !isDeaf && afkUsers.has(member.id)) {
    afkUsers.delete(member.id);

    try {
      if (member.nickname?.startsWith('[AFK]')) {
        await member.setNickname(member.nickname.replace('[AFK] ', ''));
      }
      await logChannel?.send(`✅ ${member.user.tag} is now active.`);
    } catch (err) {
      console.warn(`⚠️ Could not restore nickname for ${member.user.tag}: ${err.code}`);
      await logChannel?.send(`✅ ${member.user.tag} is now active (nickname unchanged).`);
    }

    if (originalVoiceChannel.has(member.id)) {
      try {
        const channelId = originalVoiceChannel.get(member.id);
        const channel = await member.guild.channels.fetch(channelId);
        if (channel?.isVoiceBased()) {
          await member.voice.setChannel(channel);
        }
      } catch (err) {
        console.warn(`⚠️ Could not move ${member.user.tag} back to original channel:`, err.code);
      }
      originalVoiceChannel.delete(member.id);
    }
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  const { author, member, guild, channel } = message;
  const userId = author.id;
  const now = Date.now();

  if (timeoutUsers.has(userId)) {
    const timeoutEnd = timeoutUsers.get(userId);
    if (timeoutEnd <= now) {
      timeoutUsers.delete(userId);
      spamTracker.delete(userId);
    } else {
      return;
    }
  }

  if (!spamTracker.has(userId)) {
    spamTracker.set(userId, { timestamps: [], lastWarned: 0 });
  }

  const userData = spamTracker.get(userId);
  userData.timestamps = userData.timestamps.filter(t => now - t < config.SPAM_SETTINGS.windowMs);
  userData.timestamps.push(now);

  const isExempt = member.roles.cache.some(role =>
    config.SPAM_SETTINGS.exemptRoles.includes(role.name) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );

  if (!isExempt) {
    if (userData.timestamps.length === config.SPAM_SETTINGS.warnThreshold && now - userData.lastWarned > 30000) {
      userData.lastWarned = now;
      await channel.send(`⚠️ ${member}, please slow down!`);
    }

    if (userData.timestamps.length >= config.SPAM_SETTINGS.timeoutThreshold) {
      try {
        const me = guild.members.me;

        if (!me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          console.log(`❌ Missing ModerateMembers permission in ${guild.name}`);
          return;
        }

        if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
          console.warn(`⚠️ Cannot timeout ${member.user.tag} (higher/equal role)`);
          await channel.send(`⚠️ ${member} is spamming, but I can't timeout due to role hierarchy.`);
          return;
        }

        await member.timeout(
          config.SPAM_SETTINGS.timeoutDuration,
          'Automated timeout for spamming'
        );

        timeoutUsers.set(userId, now + config.SPAM_SETTINGS.timeoutDuration);
        spamTracker.delete(userId);
        await channel.send(`⏳ ${member} has been timed out for 2 minutes.`);
      } catch (error) {
        console.error(`❌ Failed to timeout ${member.user.tag}:`, error);
        await channel.send(`⚠️ Tried to timeout ${member}, but an error occurred.`);
      }
    }
  }

  for (const mentioned of message.mentions.users.values()) {
    if (afkUsers.has(mentioned.id)) {
      const duration = formatDuration(now - afkUsers.get(mentioned.id));
      await message.reply(`🔕 ${mentioned} is AFK (${duration})`);
    }
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'afklist') {
      if (afkUsers.size === 0) {
        await interaction.reply("✅ No users are currently AFK.");
      } else {
        const list = [];
        for (const [id, since] of afkUsers) {
          const member = await interaction.guild.members.fetch(id).catch(() => null);
          if (member) {
            list.push(`🔕 ${member.user.tag} - ${formatDuration(Date.now() - since)}`);
          }
        }
        await interaction.reply({
          content: `**AFK Users:**\n${list.join('\n')}`,
          ephemeral: true
        });
      }
    }

    if (interaction.commandName === 'status') {
      const target = interaction.options.getUser('user');
      const isAfk = afkUsers.has(target.id);
      const timeoutUntil = timeoutUsers.get(target.id);

      let reply = `📄 **Status for ${target}**:\n`;
      reply += `🔕 AFK: ${isAfk ? `Yes (${formatDuration(Date.now() - afkUsers.get(target.id))})` : "No"}\n`;

      if (timeoutUntil && timeoutUntil > Date.now()) {
        reply += `⏳ Timeout: Active (${formatDuration(timeoutUntil - Date.now())} left)\n`;
      } else {
        reply += `⏳ Timeout: No\n`;
        if (timeoutUntil) timeoutUsers.delete(target.id);
      }

      await interaction.reply({ content: reply, ephemeral: true });
    }
  } catch (error) {
    console.error('Command error:', error);
    if (!interaction.replied) {
      await interaction.reply({
        content: '❌ An error occurred while processing your command.',
        ephemeral: true
      });
    }
  }
});

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes % 60}m`);
  parts.push(`${seconds % 60}s`);

  return parts.join(' ');
}

setInterval(() => {
  const now = Date.now();
  timeoutUsers.forEach((endTime, userId) => {
    if (endTime <= now) timeoutUsers.delete(userId);
  });
  spamTracker.forEach((data, userId) => {
    data.timestamps = data.timestamps.filter(t => now - t < config.SPAM_SETTINGS.windowMs);
    if (data.timestamps.length === 0) spamTracker.delete(userId);
  });
}, 60000);

client.login(process.env.TOKEN);
