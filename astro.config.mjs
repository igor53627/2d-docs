// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages deploy: https://igor53627.github.io/2d-docs/
export default defineConfig({
	site: 'https://igor53627.github.io',
	base: '/2d-docs',
	integrations: [
		starlight({
			title: '2D docs',
			description:
				'Documentation for the 2D chain — a Tron- and Ethereum-compatible, USDC-native L1.',
			defaultLocale: 'root',
			locales: {
				root: {
					label: 'English',
					lang: 'en',
				},
				ru: {
					label: 'Русский',
					lang: 'ru',
				},
			},
			social: [
				{
					icon: 'github',
					label: 'Source',
					href: 'https://github.com/igor53627/2d',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/igor53627/2d-docs/edit/main/',
			},
			sidebar: [
				{
					label: 'Architecture',
					translations: {
						ru: 'Архитектура',
					},
					items: [
						{
							label: 'Tron & Ethereum addresses',
							translations: {
								ru: 'Адреса Tron и Ethereum',
							},
							slug: 'architecture/addresses',
						},
						{
							label: 'Precompiles (no EVM)',
							translations: {
								ru: 'Precompile-ы (без EVM)',
							},
							slug: 'architecture/precompiles',
						},
						{
							label: 'State roots (no validators)',
							translations: {
								ru: 'State roots (без валидаторов)',
							},
							slug: 'architecture/state-roots',
						},
						{
							label: 'Gasless transactions',
							translations: {
								ru: 'Бесплатные транзакции',
							},
							slug: 'architecture/gasless',
						},
						{
							label: 'Security model',
							translations: {
								ru: 'Модель безопасности',
							},
							slug: 'architecture/security',
						},
						{
							label: 'Running a verifier',
							translations: {
								ru: 'Запуск верификатора',
							},
							slug: 'architecture/verifier',
						},
					],
				},
			],
		}),
	],
});
