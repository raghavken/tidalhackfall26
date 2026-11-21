`timescale 1ns/1ps
module tb_uart_rx;
reg clk=0, reset_n=0, rx=1;
always #5 clk=~clk;
wire [7:0] data; wire valid, error;
integer count=0, errors=0;
reg [7:0] expected [0:3];
uart_rx #(.CLOCK_HZ(1600000),.BAUD(100000)) dut(clk,reset_n,rx,data,valid,error);
always @(posedge clk) begin
 if(valid) begin
  if(count>=4 || data!==expected[count]) $fatal(1,"FAIL RX byte %d %h",count,data);
  count=count+1;
 end
 if(error) errors=errors+1;
end
task send;
 input [7:0] b; input stop;
 integer i;
 begin
  @(negedge clk); rx=0; repeat(16) @(negedge clk);
  for(i=0;i<8;i=i+1) begin rx=b[i]; repeat(16) @(negedge clk); end
  rx=stop; repeat(16) @(negedge clk);
 end
endtask
initial begin
 expected[0]=0; expected[1]=255; expected[2]=170; expected[3]=85;
 repeat(5) @(negedge clk); reset_n=1;
 send(0,1); send(255,1); send(170,1); send(85,1);
 send(23,0); rx=1; repeat(32) @(negedge clk);
 if(count!=4 || errors!=1) $fatal(1,"FAIL RX counts");
 $display("PASS uart_rx bytes, back-to-back, bad stop"); $finish;
end
initial begin #100000; $fatal(1,"FAIL RX timeout"); end
endmodule
