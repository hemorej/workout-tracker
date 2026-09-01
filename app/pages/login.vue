<script setup lang="ts">
/**
 * Login page — split-panel layout.
 *
 * Left: full-height orange brand panel (mark, headline, footer line).
 * Right: the sign-in form as underline fields on a white canvas.
 *
 * Presentation only — the auth store call, loading ref, toast error path
 * and post-login redirect are unchanged.
 */

import { useAuthStore } from '~/stores/auth'

// Redirect already-logged-in users away from this page
definePageMeta({ middleware: 'guest' })

useHead({ title: 'Log In' })

const auth = useAuthStore()
const toast = useToast()

// ── Login form ───────────────────────────────────────────────────────────
const loginForm = reactive({ email: '', password: '' })
const loginLoading = ref(false)

async function handleLogin() {
  loginLoading.value = true
  try {
    await auth.login(loginForm.email, loginForm.password)
    await navigateTo('/')
  }
  catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Login failed. Please try again.'
    toast.add({ title: 'Login failed', description: message, color: 'error' })
  }
  finally {
    loginLoading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-white md:flex-row">

    <!-- ── Brand panel ───────────────────────────────────────────────────
      Flat orange field. Three blocks pinned top / middle / bottom by
      `justify-between`. On mobile it collapses to a top band.
    -->
    <div
      class="flex flex-col justify-between bg-orange-600 px-6 pt-9 pb-10 md:w-[46%] md:p-10 lg:px-14 lg:py-[52px]"
    >
      <!-- Mark + wordmark -->
      <div class="flex items-center gap-3.5">
        <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.18]">
          <BikeLogo :size="27" class="text-white [stroke-width:2.8]" />
        </div>
        <span class="text-[26px] font-extrabold tracking-[-0.02em] text-white">Sprocket</span>
      </div>

      <!-- Headline -->
      <div class="max-w-[460px]">
        <h2
          class="mb-5 text-pretty text-[32px] font-extrabold leading-[1.06] tracking-[-0.035em] text-white md:text-[40px] lg:text-[52px]"
        >
          Plan, train and track workouts in one place.
        </h2>
        <p class="text-[18px] font-normal leading-[1.65] text-white/[0.82]">
          No-nonsense training for self-coached cyclists.
        </p>
      </div>

      <!-- Footer line (hidden on the mobile top band) -->
      <div class="hidden text-[14px] font-medium text-white/[0.72] md:block">
      </div>
    </div>

    <!-- ── Form panel ────────────────────────────────────────────────────── -->
    <div
      class="flex flex-1 items-center justify-center bg-white px-6 py-10 md:px-14 md:py-12 lg:px-24 lg:py-16"
    >
      <div class="w-full md:max-w-[392px]">
        <h1 class="text-[38px] font-extrabold tracking-[-0.03em] text-stone-900">
          Welcome back
        </h1>
        <p class="mt-2.5 mb-10 text-[16px] font-normal text-stone-500"></p>

        <form method="post" @submit.prevent="handleLogin">

          <input
            id="email"
            v-model="loginForm.email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            required
            class="mb-7 w-full rounded-none border-0 border-b-[1.5px] border-stone-300 bg-transparent px-0.5 py-2.5 text-[17px] font-normal text-stone-900 outline-none placeholder:text-stone-400 focus:border-orange-600 focus-visible:border-orange-600"
          >

          <input
            id="password"
            v-model="loginForm.password"
            type="password"
            placeholder="•••••••••••"
            autocomplete="current-password"
            required
            class="mb-9 w-full rounded-none border-0 border-b-[1.5px] border-stone-300 bg-transparent px-0.5 py-2.5 text-[17px] font-normal text-stone-900 outline-none placeholder:text-stone-400 focus:border-orange-600 focus-visible:border-orange-600"
          >

          <UButton
            type="submit"
            :loading="loginLoading"
            :disabled="loginLoading"
            block
            color="neutral"
            class="justify-center rounded-full bg-orange-600 py-4 text-[16px] font-bold text-white hover:bg-orange-600"
          >
            Sign in
          </UButton>
        </form>

        <!--
          Sign-up is disabled (no registration flow) — footer kept here,
          hidden for now. Restore when a signup route exists:

          <p class="mt-6 text-center text-[15px] font-normal text-stone-500">
            New to Sprocket?
            <NuxtLink to="/register" class="font-semibold text-orange-700 hover:text-orange-800">Create an account</NuxtLink>
          </p>
        -->
      </div>
    </div>

  </div>
</template>
