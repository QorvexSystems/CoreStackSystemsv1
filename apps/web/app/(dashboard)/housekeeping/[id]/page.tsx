import { HousekeepingRoomDetail } from '@/components/hotel/housekeeping-room-detail';

export default async function HousekeepingRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HousekeepingRoomDetail roomId={id} />;
}
