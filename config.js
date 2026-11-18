// Everything personal lives here. Edit freely, no build step needed.
window.TERMINAL_CONFIG = {
  user: 'sardar',
  host: 'altynkhan',

  whoami: 'Altynkhan Sardar, Developer, Student',
  pwd: 'Edville International School',

  // The about card visitors see first; its "Enter the Terminal" button boots the shell.
  // Remove this block to go straight to the terminal.
  card: {
    name: 'Sardar Altynkhan',
    tagline: 'Student at Edville International School',
    photo: 'pictures/photoofme.jpg',
    about: [
      'I really enjoy programming and math, especially geometry. I run NixOS on my laptop and GrapheneOS on my Pixel 10a.',
      "I also love reading. My favourite authors are Stephen King, Ernest Hemingway, Alexandre Dumas and Agatha Christie. When I'm gaming, it's usually Minecraft, Terraria, Factorio or The Binding of Isaac: Rebirth.",
      "I'm open to a conversation with anyone, so feel free to reach out:",
    ],
    contacts: [
      { label: 'telegram', text: '@nixopsec', href: 'https://t.me/nixopsec' },
      { label: 'email', text: 'sardar@altynkhan.com', href: 'mailto:sardar@altynkhan.com' },
      { label: 'github', text: 'forge-sa', href: 'https://github.com/forge-sa' },
    ],
  },

  // GitHub account the Projects/ folder and READMEs are pulled from.
  github: 'forge-sa',
  includeForks: false,

  // Shown in Projects/ only if the GitHub API can't be reached (offline, rate limit).
  // READMEs are still fetched live from raw.githubusercontent.com.
  fallbackProjects: [
    { name: 'EdvilleMoggBot', branch: 'main' },
    { name: 'isaac-mod-builder', branch: 'main' },
    { name: 'nopork', branch: 'master' },
    { name: 'noporkplugin', branch: 'main' },
    { name: 'remotefetch-lavis', branch: 'master' },
    { name: 'six-seven-charge-tgbot', branch: 'main' },
    { name: 'six-seven-charge-tgbot-win', branch: 'main' },
    { name: 'six-seven-charge-tgbot-mac', branch: 'main' },
    { name: 'villager-discount-cap', branch: 'main' },
    { name: 'RetroTermWeb', branch: 'main' },
  ],

  // Files in Pictures/. Drop images into ./pictures and list them here.
  // `src` can also be a full https:// URL.
  pictures: [
    { name: 'avatar.jpg', src: 'pictures/avatar.jpg', size: '19K' },
    { name: 'lavis.png', src: 'pictures/lavis.png', size: '19K' },
    { name: 'apple.png', src: 'pictures/apple.png', size: '19K' },
    { name: 'nixos.jpg', src: 'pictures/nixos.jpg', size: '19K' },
  ],

  // green | amber | white
  theme: 'green',
};
