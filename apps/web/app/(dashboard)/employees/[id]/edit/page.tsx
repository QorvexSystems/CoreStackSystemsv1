import { EmployeeForm } from '@/components/operations/employee-form';

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EmployeeForm employeeId={id} />;
}
