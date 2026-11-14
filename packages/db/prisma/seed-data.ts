/**
 * Conteúdo base do jogo (configuração, não dados de jogadores).
 * Alterável depois pelo painel administrativo. Seeds são idempotentes (upsert por `code`).
 */
import type { GameMode, MissionPeriod } from "@prisma/client";
import { WEAPON_CATALOG } from "@vanta/shared";

export const COIN_PACKAGES = [
  { code: "VC_500", coins: 500, bonusCoins: 0, priceCents: 990, sortOrder: 1 },
  { code: "VC_1200", coins: 1200, bonusCoins: 0, priceCents: 1990, sortOrder: 2 },
  { code: "VC_2800", coins: 2800, bonusCoins: 0, priceCents: 3990, sortOrder: 3 },
  { code: "VC_6000", coins: 6000, bonusCoins: 0, priceCents: 7990, sortOrder: 4 },
  { code: "VC_13000", coins: 13000, bonusCoins: 0, priceCents: 14990, sortOrder: 5 },
];

export const CHARACTERS = [
  { code: "RAVEN", name: "RAVEN", role: "Combate tático", primaryColor: "#287BFF",
    personality: "Calma sob pressão, fala pouco e decide rápido.",
    lore: "Ex-comandante de esquadrão da Coalizão Austral, Raven abandonou a patente depois que seu pelotão foi sacrificado por uma corporação. Hoje lidera operações VANTA com uma única regra: ninguém fica para trás." },
  { code: "GHOST", name: "GHOST", role: "Operador furtivo", primaryColor: "#9AA6BF",
    personality: "Irônico, paciente, gosta de aparecer onde ninguém espera.",
    lore: "Ninguém sabe o nome verdadeiro de Ghost. Os registros dizem que morreu três vezes. Seu traje de dispersão óptica foi roubado de um laboratório que oficialmente nunca existiu." },
  { code: "NOVA", name: "NOVA", role: "Especialista tecnológica", primaryColor: "#823BFF",
    personality: "Curiosa, acelerada, sempre desmontando alguma coisa.",
    lore: "Prodígio da engenharia de enxames, Nova construiu seu primeiro drone aos nove anos. Entrou para a VANTA para recuperar o código de uma IA que ela mesma criou e que foi transformada em arma." },
  { code: "TITAN", name: "TITAN", role: "Combatente pesado", primaryColor: "#FF9A2E",
    personality: "Protetor, bem-humorado, impossível de intimidar.",
    lore: "Antigo operário das minas orbitais, Titan sobreviveu a um colapso que soterrou 40 colegas e carregou 12 deles para fora. O exoesqueleto industrial que usava virou sua armadura." },
  { code: "ZERO", name: "ZERO", role: "Especialista em precisão", primaryColor: "#E8ECF4",
    personality: "Metódica, fria, mede tudo em milissegundos.",
    lore: "Atiradora de competição que se recusou a perder um campeonato comprado. Seu implante ocular calcula vento, distância e respiração. Zero nunca erra duas vezes." },
  { code: "VIPER", name: "VIPER", role: "Operador de infiltração", primaryColor: "#3FBF7F",
    personality: "Provocador, imprevisível, leal apenas a quem merece.",
    lore: "Cresceu nos becos de Neon District vendendo informações. Viper conhece cada duto, porta de serviço e câmera cega da cidade, e cobra caro por esse mapa." },
  { code: "ECHO", name: "ECHO", role: "Reconhecimento", primaryColor: "#2ED3E6",
    personality: "Atento, gentil, fala com o time o tempo todo.",
    lore: "Cartógrafa acústica criada em uma base polar, Echo enxerga o campo de batalha pelo som. Seus sensores mapeiam passos através de paredes de concreto." },
  { code: "ORION", name: "ORION", role: "Combatente de elite", primaryColor: "#FF2E63",
    personality: "Carismático, competitivo, obcecado por ser o melhor.",
    lore: "Campeão invicto das arenas de treinamento da VANTA, Orion foi o primeiro operador a alcançar a patente Supremo. Agora treina recrutas e procura alguém capaz de vencê-lo." },
];

/** Arsenal inicial: definido em @vanta/shared (mesma fonte usada nos testes de balanceamento). */
export const WEAPONS = WEAPON_CATALOG;

const ALL_MODES: GameMode[] = ["DUEL_1V1", "TEAM_2V2", "TEAM_3V3", "TRAINING"];

export const MAPS = [
  { code: "NEON_DISTRICT", name: "Neon District", description: "Cidade futurista abandonada: ruas estreitas, interiores e letreiros neon em azul e roxo.", supportedModes: ALL_MODES },
  { code: "DESERT_PROTOCOL", name: "Desert Protocol", description: "Instalação militar no deserto com túneis, torres de observação e longas linhas de visão.", supportedModes: ALL_MODES },
  { code: "FROST_BASE", name: "Frost Base", description: "Base industrial congelada: corredores internos, pátios nevados e iluminação fria.", supportedModes: ALL_MODES },
  { code: "BLACKOUT_LAB", name: "Blackout Lab", description: "Laboratório secreto com portas automáticas, salas escuras e iluminação dinâmica.", supportedModes: ALL_MODES },
  { code: "ORBITAL_ZERO", name: "Orbital Zero", description: "Estação espacial com janelas para o vazio e um setor de gravidade reduzida.", supportedModes: ALL_MODES },
];

export const MISSIONS: Array<{ code: string; name: string; description: string; period: MissionPeriod; objective: object; rewardXp: number; rewardCoins: number }> = [
  { code: "DAILY_PLAY_3", name: "Em serviço", description: "Jogue 3 partidas de qualquer modo.", period: "DAILY", objective: { stat: "matchesPlayed", target: 3 }, rewardXp: 300, rewardCoins: 0 },
  { code: "DAILY_HEADSHOTS_10", name: "Linha da cabeça", description: "Consiga 10 headshots.", period: "DAILY", objective: { stat: "headshots", target: 10 }, rewardXp: 250, rewardCoins: 0 },
  { code: "WEEKLY_WIN_10", name: "Semana de vitórias", description: "Vença 10 partidas.", period: "WEEKLY", objective: { stat: "wins", target: 10 }, rewardXp: 1500, rewardCoins: 25 },
  { code: "WEEKLY_KILLS_100", name: "Operação limpeza", description: "Elimine 100 adversários.", period: "WEEKLY", objective: { stat: "kills", target: 100 }, rewardXp: 1200, rewardCoins: 25 },
];

export const ACHIEVEMENTS = [
  { code: "FIRST_BLOOD", name: "Primeiro sangue", description: "Consiga sua primeira eliminação.", iconKey: "first_blood", objective: { stat: "kills", target: 1 }, rewardXp: 100 },
  { code: "FIRST_WIN", name: "Primeira vitória", description: "Vença sua primeira partida.", iconKey: "first_win", objective: { stat: "wins", target: 1 }, rewardXp: 200 },
  { code: "SHARPSHOOTER", name: "Atirador de elite", description: "Acumule 500 headshots.", iconKey: "sharpshooter", objective: { stat: "headshots", target: 500 }, rewardXp: 1000, rewardTitle: "Atirador de Elite" },
  { code: "MVP_10", name: "Destaque", description: "Seja MVP em 10 partidas.", iconKey: "mvp", objective: { stat: "mvpCount", target: 10 }, rewardXp: 800, rewardTitle: "Destaque" },
];
