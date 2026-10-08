// Everything personal lives here. Edit freely, no build step needed.
window.TERMINAL_CONFIG = {
  user: 'altynkhan',
  host: 'edville',

  whoami: 'Altynkhan Sardar, Developer, Student',
  pwd: 'Edville International School',

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
    { name: 'nixos.jpg', src: 'pictures/nixos.jpg', size: '19K' },
  ],

  // green | amber | white
  theme: 'green',
};
