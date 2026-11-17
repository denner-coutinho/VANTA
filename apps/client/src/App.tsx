import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import { BootScreen } from "./screens/BootScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { ForgotPasswordScreen, ResetPasswordScreen, VerifyEmailScreen } from "./screens/RecoveryScreens";
import { MainMenu } from "./screens/MainMenu";
import { PlayScreen } from "./screens/PlayScreen";
import { MatchScreen } from "./screens/MatchScreen";
import { RankedScreen } from "./screens/RankedScreen";
import { StoreScreen } from "./screens/StoreScreen";
import { InventoryScreen } from "./screens/InventoryScreen";
import { TrainingScreen } from "./screens/TrainingScreen";
import { RoomsScreen } from "./screens/RoomsScreen";
import { RoomLobby } from "./screens/RoomLobby";
import { SpectateScreen } from "./screens/SpectateScreen";
import { ProgressScreen } from "./screens/ProgressScreen";
import { ClanScreen } from "./screens/ClanScreen";
import { RankingScreen } from "./screens/RankingScreen";
import { PlayerProfileScreen } from "./screens/PlayerProfileScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { ReplayScreen } from "./screens/ReplayScreen";
import { InviteStack } from "./social/PartyWidget";

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "checking") return null;
  return status === "authenticated" ? <>{children}</> : <Navigate to="/login" replace />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "checking") return null;
  return status === "anonymous" ? <>{children}</> : <Navigate to="/menu" replace />;
}

export function App() {
  const location = useLocation();
  return (
    <>
    <Routes location={location} key={location.pathname}>
      <Route path="/" element={<BootScreen />} />
      <Route path="/login" element={<GuestOnly><LoginScreen /></GuestOnly>} />
      <Route path="/cadastro" element={<GuestOnly><RegisterScreen /></GuestOnly>} />
      <Route path="/recuperar-senha" element={<ForgotPasswordScreen />} />
      <Route path="/redefinir-senha" element={<ResetPasswordScreen />} />
      <Route path="/verificar-email" element={<VerifyEmailScreen />} />
      <Route path="/menu" element={<RequireAuth><MainMenu /></RequireAuth>} />
      <Route path="/treinamento" element={<RequireAuth><TrainingScreen /></RequireAuth>} />
      <Route path="/jogar" element={<RequireAuth><PlayScreen /></RequireAuth>} />
      <Route path="/ranqueado" element={<RequireAuth><RankedScreen /></RequireAuth>} />
      <Route path="/loja" element={<RequireAuth><StoreScreen /></RequireAuth>} />
      <Route path="/inventario" element={<RequireAuth><InventoryScreen /></RequireAuth>} />
      <Route path="/partida" element={<RequireAuth><MatchScreen /></RequireAuth>} />
      <Route path="/salas" element={<RequireAuth><RoomsScreen /></RequireAuth>} />
      <Route path="/sala" element={<RequireAuth><RoomLobby /></RequireAuth>} />
      <Route path="/progresso" element={<RequireAuth><ProgressScreen /></RequireAuth>} />
      <Route path="/cla" element={<RequireAuth><ClanScreen /></RequireAuth>} />
      <Route path="/cla/:tag" element={<RequireAuth><ClanScreen /></RequireAuth>} />
      <Route path="/ranking" element={<RequireAuth><RankingScreen /></RequireAuth>} />
      <Route path="/jogador/:username" element={<RequireAuth><PlayerProfileScreen /></RequireAuth>} />
      <Route path="/replay/:matchId" element={<RequireAuth><ReplayScreen /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><AdminScreen /></RequireAuth>} />
      <Route path="/assistir" element={<RequireAuth><SpectateScreen /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <InviteStack />
    </>
  );
}
