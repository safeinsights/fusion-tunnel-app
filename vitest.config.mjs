import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: { tsconfigPaths: true },
    test: {
        setupFiles: ['./tests/vitest.setup.ts'],
        mockReset: true,
        reporters: process.env.CI ? ['default', 'github-actions'] : ['verbose'],
        environment: 'node',
        env: { NODE_ENV: 'test' },
        include: ['src/**/*.test.ts', 'testing/**/*.test.ts', 'tests/**/*.test.ts'],
        coverage: {
            enabled: true,
            thresholds: {
                lines: 80,
                statements: 80,
                functions: 80,
                branches: 70,
            },
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
            reportOnFailure: true,
        },
    },
})
